// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title DirectionalTaxHook
/// @notice Per-pool immutable buy/sell tax hook. Instances are EIP-1167 clones created by
/// DirectionalTaxHookFactory; every clone is permanently bound to one pool and one collector.
contract DirectionalTaxHook is BaseHook {
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;
    using SafeCast for int128;
    using SafeCast for uint256;

    uint16 public constant BPS_DENOMINATOR = 10_000;

    address public immutable factory;

    struct TaxConfig {
        PoolId poolId;
        address collector;
        address taxToken;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        bool initialized;
    }

    TaxConfig private _config;

    error OnlyFactory();
    error AlreadyConfigured();
    error WrongHookAddress();
    error PoolFeeMustBeZero();
    error InvalidTaxToken();
    error InvalidTaxRate(uint16 bps);
    error InvalidCollector();
    error UnauthorizedPoolInitialization();
    error WrongPool();

    event PoolTaxConfigured(
        PoolId indexed poolId,
        address indexed collector,
        address indexed taxToken,
        uint16 buyTaxBps,
        uint16 sellTaxBps
    );
    event TaxCollected(
        PoolId indexed poolId,
        address indexed collector,
        address indexed currency,
        uint256 amount,
        bool isBuy,
        uint16 taxBps
    );

    constructor(IPoolManager manager, address factory_) BaseHook(manager) {
        if (factory_ == address(0)) revert OnlyFactory();
        factory = factory_;
    }

    /// @dev The implementation address has arbitrary low bits. The factory checks every clone's
    /// exact permission bits before configuration, and PoolManager independently enforces them.
    function validateHookAddress(BaseHook) internal pure override {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function config()
        external
        view
        returns (
            bytes32 poolId,
            address collector,
            address taxToken,
            uint16 buyTaxBps,
            uint16 sellTaxBps,
            bool initialized
        )
    {
        TaxConfig memory cfg = _config;
        return (
            PoolId.unwrap(cfg.poolId),
            cfg.collector,
            cfg.taxToken,
            cfg.buyTaxBps,
            cfg.sellTaxBps,
            cfg.initialized
        );
    }

    /// @notice Called once by the factory immediately after clone deployment. Configuration and
    /// PoolManager initialization happen atomically; no public setter exists afterward.
    function configureAndInitialize(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        address taxToken,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        address collector
    ) external returns (int24 tick) {
        if (msg.sender != factory) revert OnlyFactory();
        if (_config.initialized) revert AlreadyConfigured();
        if (address(key.hooks) != address(this)) revert WrongHookAddress();
        if (key.fee != 0) revert PoolFeeMustBeZero();
        if (collector == address(0)) revert InvalidCollector();
        if (taxToken != Currency.unwrap(key.currency0) && taxToken != Currency.unwrap(key.currency1)) {
            revert InvalidTaxToken();
        }
        if (!_isAllowedTaxRate(buyTaxBps)) revert InvalidTaxRate(buyTaxBps);
        if (!_isAllowedTaxRate(sellTaxBps)) revert InvalidTaxRate(sellTaxBps);

        PoolId id = key.toId();
        _config = TaxConfig({
            poolId: id,
            collector: collector,
            taxToken: taxToken,
            buyTaxBps: buyTaxBps,
            sellTaxBps: sellTaxBps,
            initialized: true
        });

        tick = poolManager.initialize(key, sqrtPriceX96);
        emit PoolTaxConfigured(id, collector, taxToken, buyTaxBps, sellTaxBps);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160)
        internal
        view
        override
        returns (bytes4)
    {
        TaxConfig memory cfg = _config;
        if (!cfg.initialized || sender != address(this)) revert UnauthorizedPoolInitialization();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(cfg.poolId)) revert WrongPool();
        return IHooks.beforeInitialize.selector;
    }

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        TaxConfig memory cfg = _config;
        PoolId id = key.toId();
        if (!cfg.initialized || PoolId.unwrap(id) != PoolId.unwrap(cfg.poolId)) revert WrongPool();

        Currency outputCurrency = params.zeroForOne ? key.currency1 : key.currency0;
        bool isBuy = Currency.unwrap(outputCurrency) == cfg.taxToken;
        uint16 taxBps = isBuy ? cfg.buyTaxBps : cfg.sellTaxBps;
        if (taxBps == 0) return (IHooks.afterSwap.selector, 0);

        // afterSwap may adjust only the unspecified currency. For exact-input swaps that is the
        // output; for exact-output swaps it is the input. This follows v4-core's own FeeTakingHook.
        bool specifiedTokenIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        Currency feeCurrency = specifiedTokenIs0 ? key.currency1 : key.currency0;
        int128 rawUnspecified = specifiedTokenIs0 ? delta.amount1() : delta.amount0();
        uint256 baseAmount = _absolute(rawUnspecified);

        uint256 feeAmount;
        if (params.amountSpecified < 0) {
            // Exact input: retain the selected fraction of the gross output.
            feeAmount = (baseAmount * taxBps) / BPS_DENOMINATOR;
        } else {
            // Exact output: gross up the pool input so fee / total user input equals taxBps.
            feeAmount = (baseAmount * taxBps) / (BPS_DENOMINATOR - taxBps);
        }

        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);
        poolManager.take(feeCurrency, cfg.collector, feeAmount);
        emit TaxCollected(
            id,
            cfg.collector,
            Currency.unwrap(feeCurrency),
            feeAmount,
            isBuy,
            taxBps
        );
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    function _absolute(int128 value) private pure returns (uint256) {
        if (value >= 0) return uint256(value.toUint128());
        // `-type(int128).min` overflows int128. Moving one step toward zero first keeps the
        // negation representable, then adding one restores the exact magnitude in uint256.
        return uint256((-(value + 1)).toUint128()) + 1;
    }

    function _isAllowedTaxRate(uint16 bps) private pure returns (bool) {
        return bps == 0 || bps == 100 || bps == 300 || bps == 500 || bps == 1_000
            || bps == 2_000 || bps == 3_000 || bps == 5_000 || bps == 8_000;
    }
}
