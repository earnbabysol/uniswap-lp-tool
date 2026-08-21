// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ConfigurableTaxHookFactoryV2} from "../src/ConfigurableTaxHookFactoryV2.sol";

/// @notice Deploys the v2 permissionless factory through Arachnid's CREATE2 proxy.
contract DeployConfigurableTaxHookFactoryV2 is Script {
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant FACTORY_SALT = keccak256("RangeDesk ConfigurableTaxHookFactory v2");

    function run() external returns (ConfigurableTaxHookFactoryV2 factory) {
        IPoolManager manager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        bytes memory initCode = abi.encodePacked(type(ConfigurableTaxHookFactoryV2).creationCode, abi.encode(manager));
        address predicted = vm.computeCreate2Address(FACTORY_SALT, keccak256(initCode), CREATE2_PROXY);

        if (predicted.code.length == 0) {
            vm.startBroadcast();
            (bool ok,) = CREATE2_PROXY.call(abi.encodePacked(FACTORY_SALT, initCode));
            vm.stopBroadcast();
            require(ok && predicted.code.length > 0, "factory deployment failed");
        }

        factory = ConfigurableTaxHookFactoryV2(predicted);
        require(address(factory.poolManager()) == address(manager), "wrong PoolManager");
    }
}
