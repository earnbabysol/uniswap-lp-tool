// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {MinimalProxy} from "./MinimalProxy.sol";
import {DirectionalTaxHook} from "./DirectionalTaxHook.sol";

/// @title DirectionalTaxHookFactory
/// @notice Permissionless factory for immutable per-pool hooks. The CREATE2 salt is namespaced by
/// creator, so copying a pending transaction cannot redirect another creator's fee collector.
contract DirectionalTaxHookFactory {
    uint160 public constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 public constant REQUIRED_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    IPoolManager public immutable poolManager;
    address public immutable implementation;

    error CurrenciesOutOfOrderOrEqual();
    error InvalidTickSpacing();
    error InvalidHookFlags(address hook);
    error WrongTaxToken();
    error InvalidTaxRate(uint16 bps);

    event DirectionalTaxPoolCreated(
        PoolId indexed poolId,
        address indexed hook,
        address indexed creator,
        address taxToken,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        bytes32 userSalt
    );

    constructor(IPoolManager manager) {
        poolManager = manager;
        implementation = address(new DirectionalTaxHook(manager, address(this)));
    }

    function derivedSalt(address creator, bytes32 userSalt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(creator, userSalt));
    }

    function cloneInitCodeHash() external view returns (bytes32) {
        return MinimalProxy.initCodeHash(implementation);
    }

    function predictHook(address creator, bytes32 userSalt) public view returns (address) {
        return MinimalProxy.predictDeterministicAddress(
            implementation,
            derivedSalt(creator, userSalt),
            address(this)
        );
    }

    function hasRequiredFlags(address hook) public pure returns (bool) {
        return uint160(hook) & ALL_HOOK_MASK == REQUIRED_FLAGS;
    }

    function createPool(
        Currency currency0,
        Currency currency1,
        int24 tickSpacing,
        uint160 sqrtPriceX96,
        address taxToken,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        bytes32 userSalt
    ) external returns (address hook, PoolId poolId, int24 tick) {
        if (currency0 >= currency1) revert CurrenciesOutOfOrderOrEqual();
        if (tickSpacing <= 0 || tickSpacing > 16_384) revert InvalidTickSpacing();
        if (taxToken != Currency.unwrap(currency0) && taxToken != Currency.unwrap(currency1)) {
            revert WrongTaxToken();
        }
        if (!_isAllowedTaxRate(buyTaxBps)) revert InvalidTaxRate(buyTaxBps);
        if (!_isAllowedTaxRate(sellTaxBps)) revert InvalidTaxRate(sellTaxBps);

        bytes32 salt = derivedSalt(msg.sender, userSalt);
        address predicted = MinimalProxy.predictDeterministicAddress(implementation, salt, address(this));
        if (!hasRequiredFlags(predicted)) revert InvalidHookFlags(predicted);
        hook = MinimalProxy.cloneDeterministic(implementation, salt);

        PoolKey memory key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 0,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });
        tick = DirectionalTaxHook(hook).configureAndInitialize(
            key,
            sqrtPriceX96,
            taxToken,
            buyTaxBps,
            sellTaxBps,
            msg.sender
        );
        (bytes32 id,,,,,) = DirectionalTaxHook(hook).config();
        poolId = PoolId.wrap(id);

        emit DirectionalTaxPoolCreated(
            poolId,
            hook,
            msg.sender,
            taxToken,
            buyTaxBps,
            sellTaxBps,
            userSalt
        );
    }

    function _isAllowedTaxRate(uint16 bps) private pure returns (bool) {
        return bps == 0 || bps == 100 || bps == 300 || bps == 500 || bps == 1_000
            || bps == 2_000 || bps == 3_000 || bps == 5_000 || bps == 8_000;
    }
}
