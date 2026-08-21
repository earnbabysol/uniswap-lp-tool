// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal EIP-1167 clone helpers with deterministic CREATE2 addresses.
library MinimalProxy {
    error CloneDeploymentFailed();

    bytes10 private constant CREATION_PREFIX = hex"3d602d80600a3d3981f3";
    bytes10 private constant RUNTIME_PREFIX = hex"363d3d373d3d3d363d73";
    bytes15 private constant RUNTIME_SUFFIX = hex"5af43d82803e903d91602b57fd5bf3";

    function initCode(address implementation) internal pure returns (bytes memory) {
        return abi.encodePacked(CREATION_PREFIX, RUNTIME_PREFIX, implementation, RUNTIME_SUFFIX);
    }

    function initCodeHash(address implementation) internal pure returns (bytes32) {
        return keccak256(initCode(implementation));
    }

    function cloneDeterministic(address implementation, bytes32 salt) internal returns (address instance) {
        bytes memory code = initCode(implementation);
        assembly ("memory-safe") {
            instance := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (instance == address(0)) revert CloneDeploymentFailed();
    }

    function predictDeterministicAddress(address implementation, bytes32 salt, address deployer)
        internal
        pure
        returns (address predicted)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash(implementation))
        );
        predicted = address(uint160(uint256(digest)));
    }
}
