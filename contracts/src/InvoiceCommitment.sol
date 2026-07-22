// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

library InvoiceCommitment {
    function compute(
        uint256 chainId,
        address registry,
        bytes32 workflowId,
        address payer,
        address payee,
        bytes32 contentHash,
        bytes32 salt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, registry, workflowId, payer, payee, contentHash, salt));
    }
}
