// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {DirectionalTaxHookFactory} from "../src/DirectionalTaxHookFactory.sol";

/// @notice Deploys the permissionless factory through Arachnid's deterministic deployment proxy.
/// The same proxy exists on Ethereum, Base, BSC and Robinhood Chain.
contract DeployDirectionalTaxHookFactory is Script {
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant FACTORY_SALT = keccak256("RangeDesk DirectionalTaxHookFactory v1");

    function run() external returns (DirectionalTaxHookFactory factory) {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        bytes memory initCode = abi.encodePacked(
            type(DirectionalTaxHookFactory).creationCode,
            abi.encode(manager)
        );
        address predicted = vm.computeCreate2Address(
            FACTORY_SALT,
            keccak256(initCode),
            CREATE2_PROXY
        );

        if (predicted.code.length == 0) {
            vm.startBroadcast();
            (bool ok,) = CREATE2_PROXY.call(abi.encodePacked(FACTORY_SALT, initCode));
            vm.stopBroadcast();
            require(ok && predicted.code.length > 0, "factory deployment failed");
        }

        factory = DirectionalTaxHookFactory(predicted);
        require(address(factory.poolManager()) == address(manager), "wrong PoolManager");
    }
}
