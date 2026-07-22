// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {InvoiceCommitment} from "../src/InvoiceCommitment.sol";

contract InvoiceCommitmentTest {
    function testFixedTypeScriptVectorMatchesSolidity() external pure {
        bytes32 actual = InvoiceCommitment.compute(
            5_042_002,
            address(0x1111111111111111111111111111111111111111),
            0x2222222222222222222222222222222222222222222222222222222222222222,
            address(0x3333333333333333333333333333333333333333),
            address(0x4444444444444444444444444444444444444444),
            0xecb96a4ef8a3c77531c467fac16e09f350e80a77d70d62f78aa60fadac660067,
            0x5555555555555555555555555555555555555555555555555555555555555555
        );

        require(
            actual == 0x8bfbe9d3530f21d5d50cf416cdab34a7cc8166dfdc5c8deda2f1a6b31a656bec,
            "TypeScript/Solidity commitment mismatch"
        );
    }
}
