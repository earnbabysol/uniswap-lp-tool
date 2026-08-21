// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {MinimalProxy} from "./MinimalProxy.sol";
import {ConfigurableTaxHookV2} from "./ConfigurableTaxHookV2.sol";

/// @title ConfigurableTaxHookFactoryV2
/// @notice Permissionless factory for v2 hooks with custom static LP fee and custom taxes.
contract ConfigurableTaxHookFactoryV2 {
    using LPFeeLibrary for uint24;

    uint160 public constant ALL_HOOK_MASK = (1 << 14) - 1;
    uint160 public constant REQUIRED_FLAGS =
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    uint16 public constant MAX_TAX_BPS = 8_000;

    IPoolManager public immutable poolManager;
    address public immutable implementation;

    error CurrenciesOutOfOrderOrEqual();
    error InvalidTickSpacing();
    error InvalidLpFee(uint24 fee);
    error InvalidHookFlags(address hook);
    error WrongTaxToken();
    error InvalidTaxRate(uint16 bps);
    error NoTaxConfigured();

    event ConfigurableTaxPoolCreatedV2(
        PoolId indexed poolId,
        address indexed hook,
        address indexed creator,
        address taxToken,
        uint24 lpFee,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        bytes32 userSalt
    );

    constructor(IPoolManager manager) {
        poolManager = manager;
        implementation = address(new ConfigurableTaxHookV2(manager, address(this)));
    }

    function derivedSalt(address creator, bytes32 userSalt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(creator, userSalt));
    }

    function cloneInitCodeHash() external view returns (bytes32) {
        return MinimalProxy.initCodeHash(implementation);
    }

    function predictHook(address creator, bytes32 userSalt) public view returns (address) {
        return MinimalProxy.predictDeterministicAddress(implementation, derivedSalt(creator, userSalt), address(this));
    }

    function hasRequiredFlags(address hook) public pure returns (bool) {
        return uint160(hook) & ALL_HOOK_MASK == REQUIRED_FLAGS;
    }

    function createPool(
        Currency currency0,
        Currency currency1,
        uint24 lpFee,
        int24 tickSpacing,
        uint160 sqrtPriceX96,
        address taxToken,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        bytes32 userSalt
    ) external returns (address hook, PoolId poolId, int24 tick) {
        if (currency0 >= currency1) revert CurrenciesOutOfOrderOrEqual();
        if (tickSpacing <= 0 || tickSpacing > 16_384) revert InvalidTickSpacing();
        if (!lpFee.isValid()) revert InvalidLpFee(lpFee);
        if (taxToken != Currency.unwrap(currency0) && taxToken != Currency.unwrap(currency1)) {
            revert WrongTaxToken();
        }
        if (buyTaxBps > MAX_TAX_BPS) revert InvalidTaxRate(buyTaxBps);
        if (sellTaxBps > MAX_TAX_BPS) revert InvalidTaxRate(sellTaxBps);
        if (buyTaxBps == 0 && sellTaxBps == 0) revert NoTaxConfigured();

        bytes32 salt = derivedSalt(msg.sender, userSalt);
        address predicted = MinimalProxy.predictDeterministicAddress(implementation, salt, address(this));
        if (!hasRequiredFlags(predicted)) revert InvalidHookFlags(predicted);
        hook = MinimalProxy.cloneDeterministic(implementation, salt);

        PoolKey memory key = PoolKey({
            currency0: currency0, currency1: currency1, fee: lpFee, tickSpacing: tickSpacing, hooks: IHooks(hook)
        });
        tick = ConfigurableTaxHookV2(hook)
            .configureAndInitialize(key, sqrtPriceX96, taxToken, buyTaxBps, sellTaxBps, msg.sender);
        (bytes32 id,,,,,,) = ConfigurableTaxHookV2(hook).config();
        poolId = PoolId.wrap(id);

        emit ConfigurableTaxPoolCreatedV2(poolId, hook, msg.sender, taxToken, lpFee, buyTaxBps, sellTaxBps, userSalt);
    }
}
