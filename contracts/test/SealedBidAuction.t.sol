// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {SealedBidAuction} from "../src/SealedBidAuction.sol";

interface AuctionVm {
    function assume(bool condition) external;
    function deal(address account, uint256 balance) external;
    function expectPartialRevert(bytes4 selector) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract SealedBidAuctionTest {
    AuctionVm private constant vm =
        AuctionVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    SealedBidAuction private auctions;

    address private constant OWNER = address(0x1001);
    address private constant BIDDER_ONE = address(0x2002);
    address private constant BIDDER_TWO = address(0x3003);
    address private constant BIDDER_THREE = address(0x4004);
    bytes32 private constant AUCTION_ID = keccak256("auction-001");
    uint256 private constant BOND = 1 ether;

    function setUp() external {
        auctions = new SealedBidAuction();
        vm.deal(BIDDER_ONE, 10 ether);
        vm.deal(BIDDER_TWO, 10 ether);
        vm.deal(BIDDER_THREE, 10 ether);
        vm.warp(100);
    }

    function testBidderCommitsBondedBidWithoutPublishingAmount() external {
        _createAuction();
        vm.warp(200);
        bytes32 commitment = keccak256("hidden-bid");

        vm.prank(BIDDER_ONE);
        auctions.commitBid{value: BOND}(AUCTION_ID, commitment);

        SealedBidAuction.BidView memory bid = auctions.getBid(AUCTION_ID, BIDDER_ONE);
        require(bid.commitment == commitment, "wrong commitment");
        require(!bid.revealed, "bid unexpectedly revealed");
        require(bid.amount == 0, "amount unexpectedly public");
        require(address(auctions).balance == BOND, "bond not held");
    }

    function testBidderRevealsOnlyTheOpeningOfTheirCommitment() external {
        _createAuction();
        uint256 amount = 75;
        bytes32 salt = keccak256("bidder-one-salt");
        bytes32 commitment = _commitment(BIDDER_ONE, amount, salt);
        vm.warp(200);
        vm.prank(BIDDER_ONE);
        auctions.commitBid{value: BOND}(AUCTION_ID, commitment);

        vm.warp(300);
        vm.prank(BIDDER_TWO);
        vm.expectPartialRevert(SealedBidAuction.BiddingClosed.selector);
        auctions.commitBid{value: BOND}(AUCTION_ID, keccak256("too-late"));
        vm.prank(BIDDER_TWO);
        vm.expectPartialRevert(SealedBidAuction.NoCommittedBid.selector);
        auctions.revealBid(AUCTION_ID, amount, salt);
        vm.prank(BIDDER_ONE);
        auctions.revealBid(AUCTION_ID, amount, salt);

        SealedBidAuction.BidView memory bid = auctions.getBid(AUCTION_ID, BIDDER_ONE);
        require(bid.revealed, "bid not revealed");
        require(bid.amount == amount, "wrong public amount");
    }

    function testFinalizationSelectsWinnerAndAccountsForEveryBond() external {
        _createAuction();
        uint256[3] memory amounts = [uint256(90), uint256(60), uint256(75)];
        address[3] memory bidders = [BIDDER_ONE, BIDDER_TWO, BIDDER_THREE];
        bytes32[3] memory salts =
            [keccak256("salt-one"), keccak256("salt-two"), keccak256("salt-three")];

        vm.warp(200);
        for (uint256 index; index < bidders.length; ++index) {
            vm.prank(bidders[index]);
            auctions.commitBid{value: BOND}(
                AUCTION_ID, _commitment(bidders[index], amounts[index], salts[index])
            );
        }

        vm.warp(300);
        for (uint256 index; index < 2; ++index) {
            vm.prank(bidders[index]);
            auctions.revealBid(AUCTION_ID, amounts[index], salts[index]);
        }

        vm.warp(400);
        vm.prank(OWNER);
        auctions.finalizeAuction(AUCTION_ID);

        SealedBidAuction.AuctionView memory auction = auctions.getAuction(AUCTION_ID);
        require(auction.finalized, "auction not finalized");
        require(auction.winner == BIDDER_TWO, "wrong winner");
        require(auction.winningAmount == 60, "wrong winning amount");
        require(auctions.creditOf(BIDDER_ONE) == BOND, "first refund missing");
        require(auctions.creditOf(BIDDER_TWO) == BOND, "second refund missing");
        require(auctions.creditOf(BIDDER_THREE) == 0, "non-revealer refunded");
        require(auctions.creditOf(OWNER) == BOND, "forfeited bond missing");
        require(address(auctions).balance == 3 * BOND, "bond conservation failed");
    }

    function testRevealedBidderWithdrawsBondThroughPullCredit() external {
        _createAuction();
        uint256 amount = 50;
        bytes32 salt = keccak256("withdrawal-salt");
        vm.warp(200);
        vm.prank(BIDDER_ONE);
        auctions.commitBid{value: BOND}(AUCTION_ID, _commitment(BIDDER_ONE, amount, salt));
        vm.warp(300);
        vm.prank(BIDDER_ONE);
        auctions.revealBid(AUCTION_ID, amount, salt);
        vm.warp(400);
        vm.prank(OWNER);
        auctions.finalizeAuction(AUCTION_ID);

        uint256 balanceBefore = BIDDER_ONE.balance;
        vm.prank(BIDDER_ONE);
        auctions.withdrawCredit();

        require(BIDDER_ONE.balance == balanceBefore + BOND, "bond not withdrawn");
        require(auctions.creditOf(BIDDER_ONE) == 0, "credit not cleared");
        require(address(auctions).balance == 0, "contract retained withdrawn bond");
    }

    function testEnforcesAuctionPhaseBoundariesAndReplayProtection() external {
        _createAuction();
        uint256 amount = 42;
        bytes32 salt = keccak256("boundary-salt");
        bytes32 commitment = _commitment(BIDDER_ONE, amount, salt);

        vm.warp(199);
        vm.prank(BIDDER_ONE);
        vm.expectPartialRevert(SealedBidAuction.BiddingNotOpen.selector);
        auctions.commitBid{value: BOND}(AUCTION_ID, commitment);

        vm.warp(200);
        vm.prank(BIDDER_ONE);
        vm.expectPartialRevert(SealedBidAuction.IncorrectBond.selector);
        auctions.commitBid{value: BOND - 1}(AUCTION_ID, commitment);
        vm.prank(BIDDER_ONE);
        auctions.commitBid{value: BOND}(AUCTION_ID, commitment);
        vm.prank(BIDDER_ONE);
        vm.expectPartialRevert(SealedBidAuction.BidAlreadyCommitted.selector);
        auctions.commitBid{value: BOND}(AUCTION_ID, commitment);

        vm.warp(299);
        vm.prank(BIDDER_ONE);
        vm.expectPartialRevert(SealedBidAuction.RevealNotOpen.selector);
        auctions.revealBid(AUCTION_ID, amount, salt);

        vm.warp(300);
        vm.prank(BIDDER_ONE);
        vm.expectPartialRevert(SealedBidAuction.InvalidOpening.selector);
        auctions.revealBid(AUCTION_ID, amount + 1, salt);
        vm.prank(BIDDER_ONE);
        auctions.revealBid(AUCTION_ID, amount, salt);
        vm.prank(BIDDER_ONE);
        vm.expectPartialRevert(SealedBidAuction.BidAlreadyRevealed.selector);
        auctions.revealBid(AUCTION_ID, amount, salt);

        vm.warp(399);
        vm.prank(OWNER);
        vm.expectPartialRevert(SealedBidAuction.FinalizationNotReady.selector);
        auctions.finalizeAuction(AUCTION_ID);

        vm.warp(400);
        vm.prank(BIDDER_ONE);
        vm.expectPartialRevert(SealedBidAuction.RevealClosed.selector);
        auctions.revealBid(AUCTION_ID, amount, salt);
        vm.prank(BIDDER_TWO);
        auctions.finalizeAuction(AUCTION_ID);
        vm.prank(OWNER);
        vm.expectPartialRevert(SealedBidAuction.AuctionAlreadyFinalized.selector);
        auctions.finalizeAuction(AUCTION_ID);
    }

    function testEqualBidTieUsesCanonicalAddressOrder() external {
        _createAuction();
        uint256 amount = 50;
        bytes32 firstSalt = keccak256("tie-one");
        bytes32 secondSalt = keccak256("tie-two");
        vm.warp(200);
        vm.prank(BIDDER_TWO);
        auctions.commitBid{value: BOND}(AUCTION_ID, _commitment(BIDDER_TWO, amount, secondSalt));
        vm.prank(BIDDER_ONE);
        auctions.commitBid{value: BOND}(AUCTION_ID, _commitment(BIDDER_ONE, amount, firstSalt));
        vm.warp(300);
        vm.prank(BIDDER_TWO);
        auctions.revealBid(AUCTION_ID, amount, secondSalt);
        vm.prank(BIDDER_ONE);
        auctions.revealBid(AUCTION_ID, amount, firstSalt);

        vm.warp(400);
        vm.prank(OWNER);
        auctions.finalizeAuction(AUCTION_ID);

        require(auctions.getAuction(AUCTION_ID).winner == BIDDER_ONE, "tie was not canonical");
    }

    function testFuzzValidCommitmentOpeningRoundTrips(uint256 amount, bytes32 salt) external {
        vm.assume(amount > 0);
        _createAuction();

        vm.warp(200);
        vm.prank(BIDDER_ONE);
        auctions.commitBid{value: BOND}(AUCTION_ID, _commitment(BIDDER_ONE, amount, salt));
        vm.warp(300);
        vm.prank(BIDDER_ONE);
        auctions.revealBid(AUCTION_ID, amount, salt);

        SealedBidAuction.BidView memory bid = auctions.getBid(AUCTION_ID, BIDDER_ONE);
        require(bid.revealed && bid.amount == amount, "opening did not round trip");
    }

    function testFuzzFinalizationConservesAllBondCredits(bool revealOne, bool revealTwo) external {
        _createAuction();
        uint256 firstAmount = 80;
        uint256 secondAmount = 60;
        bytes32 firstSalt = keccak256("conservation-one");
        bytes32 secondSalt = keccak256("conservation-two");

        vm.warp(200);
        vm.prank(BIDDER_ONE);
        auctions.commitBid{value: BOND}(AUCTION_ID, _commitment(BIDDER_ONE, firstAmount, firstSalt));
        vm.prank(BIDDER_TWO);
        auctions.commitBid{value: BOND}(
            AUCTION_ID, _commitment(BIDDER_TWO, secondAmount, secondSalt)
        );

        vm.warp(300);
        if (revealOne) {
            vm.prank(BIDDER_ONE);
            auctions.revealBid(AUCTION_ID, firstAmount, firstSalt);
        }
        if (revealTwo) {
            vm.prank(BIDDER_TWO);
            auctions.revealBid(AUCTION_ID, secondAmount, secondSalt);
        }

        vm.warp(400);
        vm.prank(OWNER);
        auctions.finalizeAuction(AUCTION_ID);

        uint256 totalCredits = auctions.creditOf(OWNER) + auctions.creditOf(BIDDER_ONE)
            + auctions.creditOf(BIDDER_TWO);
        require(totalCredits == address(auctions).balance, "credits do not conserve bonds");
        require(totalCredits == 2 * BOND, "bond value was created or lost");
    }

    function _createAuction() private {
        vm.prank(OWNER);
        auctions.createAuction(AUCTION_ID, 200, 300, 400, BOND);
    }

    function _commitment(address bidder, uint256 amount, bytes32 salt)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(block.chainid, address(auctions), AUCTION_ID, bidder, amount, salt)
        );
    }
}
