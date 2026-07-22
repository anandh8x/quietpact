// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract SealedBidAuction {
    uint32 public constant MAX_BIDDERS = 128;

    struct AuctionView {
        address owner;
        uint64 commitOpensAt;
        uint64 revealOpensAt;
        uint64 revealClosesAt;
        uint256 bond;
        uint32 bidderCount;
        address winner;
        uint256 winningAmount;
        bool finalized;
    }

    struct BidView {
        bytes32 commitment;
        uint256 amount;
        bool revealed;
    }

    error AuctionAlreadyExists(bytes32 auctionId);
    error AuctionAlreadyFinalized(bytes32 auctionId);
    error AuctionNotFound(bytes32 auctionId);
    error BiddingClosed(bytes32 auctionId);
    error BiddingNotOpen(bytes32 auctionId);
    error BidAlreadyCommitted(bytes32 auctionId, address bidder);
    error BidAlreadyRevealed(bytes32 auctionId, address bidder);
    error IncorrectBond(uint256 received, uint256 required);
    error InvalidAuctionData();
    error InvalidBidAmount();
    error InvalidCommitment();
    error InvalidOpening(bytes32 auctionId, address bidder);
    error NoCommittedBid(bytes32 auctionId, address bidder);
    error NothingToWithdraw();
    error FinalizationNotReady(bytes32 auctionId);
    error RevealClosed(bytes32 auctionId);
    error RevealNotOpen(bytes32 auctionId);
    error TooManyBidders(bytes32 auctionId);
    error TransferFailed();

    event AuctionCreated(
        bytes32 indexed auctionId,
        address indexed owner,
        uint64 commitOpensAt,
        uint64 revealOpensAt,
        uint64 revealClosesAt,
        uint256 bond
    );
    event BidCommitted(bytes32 indexed auctionId, address indexed bidder, bytes32 commitment);
    event BidRevealed(bytes32 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionFinalized(
        bytes32 indexed auctionId,
        address indexed winner,
        uint256 winningAmount,
        uint256 forfeitedBond
    );
    event CreditWithdrawn(address indexed account, uint256 amount);

    mapping(bytes32 auctionId => AuctionView auction) private auctions;
    mapping(bytes32 auctionId => mapping(address bidder => BidView bid)) private bids;
    mapping(bytes32 auctionId => address[] bidders) private auctionBidders;
    mapping(address account => uint256 credit) private credits;

    function createAuction(
        bytes32 auctionId,
        uint64 commitOpensAt,
        uint64 revealOpensAt,
        uint64 revealClosesAt,
        uint256 bond
    ) external {
        if (
            auctionId == bytes32(0) || commitOpensAt < block.timestamp
                || commitOpensAt >= revealOpensAt || revealOpensAt >= revealClosesAt || bond == 0
        ) revert InvalidAuctionData();
        if (auctions[auctionId].owner != address(0)) revert AuctionAlreadyExists(auctionId);

        auctions[auctionId] = AuctionView({
            owner: msg.sender,
            commitOpensAt: commitOpensAt,
            revealOpensAt: revealOpensAt,
            revealClosesAt: revealClosesAt,
            bond: bond,
            bidderCount: 0,
            winner: address(0),
            winningAmount: 0,
            finalized: false
        });

        emit AuctionCreated(
            auctionId, msg.sender, commitOpensAt, revealOpensAt, revealClosesAt, bond
        );
    }

    function commitBid(bytes32 auctionId, bytes32 commitment) external payable {
        AuctionView storage auction = _requireAuction(auctionId);
        if (block.timestamp < auction.commitOpensAt) revert BiddingNotOpen(auctionId);
        if (block.timestamp >= auction.revealOpensAt) revert BiddingClosed(auctionId);
        if (commitment == bytes32(0)) revert InvalidCommitment();
        if (msg.value != auction.bond) revert IncorrectBond(msg.value, auction.bond);
        if (bids[auctionId][msg.sender].commitment != bytes32(0)) {
            revert BidAlreadyCommitted(auctionId, msg.sender);
        }
        if (auction.bidderCount == MAX_BIDDERS) revert TooManyBidders(auctionId);

        bids[auctionId][msg.sender].commitment = commitment;
        auctionBidders[auctionId].push(msg.sender);
        unchecked {
            ++auction.bidderCount;
        }

        emit BidCommitted(auctionId, msg.sender, commitment);
    }

    function revealBid(bytes32 auctionId, uint256 amount, bytes32 salt) external {
        AuctionView storage auction = _requireAuction(auctionId);
        if (block.timestamp < auction.revealOpensAt) revert RevealNotOpen(auctionId);
        if (block.timestamp >= auction.revealClosesAt) revert RevealClosed(auctionId);
        if (amount == 0) revert InvalidBidAmount();

        BidView storage bid = bids[auctionId][msg.sender];
        if (bid.commitment == bytes32(0)) revert NoCommittedBid(auctionId, msg.sender);
        if (bid.revealed) revert BidAlreadyRevealed(auctionId, msg.sender);

        bytes32 opening = keccak256(
            abi.encode(block.chainid, address(this), auctionId, msg.sender, amount, salt)
        );
        if (opening != bid.commitment) revert InvalidOpening(auctionId, msg.sender);

        bid.amount = amount;
        bid.revealed = true;
        emit BidRevealed(auctionId, msg.sender, amount);
    }

    function finalizeAuction(bytes32 auctionId) external {
        AuctionView storage auction = _requireAuction(auctionId);
        if (block.timestamp < auction.revealClosesAt) revert FinalizationNotReady(auctionId);
        if (auction.finalized) revert AuctionAlreadyFinalized(auctionId);

        address winner;
        uint256 winningAmount;
        uint256 forfeitedBond;
        address[] storage bidders_ = auctionBidders[auctionId];
        for (uint256 index; index < bidders_.length; ++index) {
            address bidder = bidders_[index];
            BidView storage bid = bids[auctionId][bidder];
            if (!bid.revealed) {
                forfeitedBond += auction.bond;
                continue;
            }

            credits[bidder] += auction.bond;
            if (
                winner == address(0) || bid.amount < winningAmount
                    || (bid.amount == winningAmount && bidder < winner)
            ) {
                winner = bidder;
                winningAmount = bid.amount;
            }
        }

        credits[auction.owner] += forfeitedBond;
        auction.winner = winner;
        auction.winningAmount = winningAmount;
        auction.finalized = true;

        emit AuctionFinalized(auctionId, winner, winningAmount, forfeitedBond);
    }

    function creditOf(address account) external view returns (uint256) {
        return credits[account];
    }

    function withdrawCredit() external {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        credits[msg.sender] = 0;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert TransferFailed();

        emit CreditWithdrawn(msg.sender, amount);
    }

    function getAuction(bytes32 auctionId) external view returns (AuctionView memory) {
        return _requireAuction(auctionId);
    }

    function getBid(bytes32 auctionId, address bidder) external view returns (BidView memory) {
        _requireAuction(auctionId);
        return bids[auctionId][bidder];
    }

    function _requireAuction(bytes32 auctionId) private view returns (AuctionView storage auction) {
        auction = auctions[auctionId];
        if (auction.owner == address(0)) revert AuctionNotFound(auctionId);
    }
}
