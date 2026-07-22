// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {QuietPactVersion} from "../src/QuietPactVersion.sol";

contract QuietPactVersionTest {
    function testVersionIdentifiesBootstrapRelease() external {
        QuietPactVersion versionContract = new QuietPactVersion();
        require(
            keccak256(bytes(versionContract.version())) == keccak256(bytes("0.0.0")),
            "unexpected version"
        );
    }
}
