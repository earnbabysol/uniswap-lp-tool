// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title ConfigurableTaxHookV2
/// @notice Per-pool immutable hook with an independent static LP fee and custom buy/sell taxes.
/// Every instance is an EIP-1167 clone permanently bound to one pool and one collector.
contract ConfigurableTaxHookV2 is BaseHook {
    using BalanceDeltaLibrary for BalanceDelta;
    using LPFeeLibrary for uint24;
    using PoolIdLibrary for PoolKey;
    using SafeCast for int128;
    using SafeCast for uint256;

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant MAX_TAX_BPS = 8_000;

    address public immutable factory;

    struct TaxConfig {
        PoolId poolId;
        address collector;
        address taxToken;
        uint24 lpFee;
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        bool initialized;
    }

    TaxConfig private _config;

    error OnlyFactory();
    error AlreadyConfigured();
    error WrongHookAddress();
    error InvalidLpFee(uint24 fee);
    error InvalidTaxToken();
    error InvalidTaxRate(uint16 bps);
    error NoTaxConfigured();
    error InvalidCollector();
    error UnauthorizedPoolInitialization();
    error WrongPool();

    event PoolTaxConfiguredV2(
        PoolId indexed poolId,
        address indexed collector,
        address indexed taxToken,
        uint24 lpFee,
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

    /// @dev The factory mines and checks every clone's exact low permission bits.
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
            uint24 lpFee,
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
            cfg.lpFee,
            cfg.buyTaxBps,
            cfg.sellTaxBps,
            cfg.initialized
        );
    }

    /// @notice Configuration and PoolManager initialization are atomic and irreversible.
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
        if (!key.fee.isValid()) revert InvalidLpFee(key.fee);
        if (collector == address(0)) revert InvalidCollector();
        if (taxToken != Currency.unwrap(key.currency0) && taxToken != Currency.unwrap(key.currency1)) {
            revert InvalidTaxToken();
        }
        if (buyTaxBps > MAX_TAX_BPS) revert InvalidTaxRate(buyTaxBps);
        if (sellTaxBps > MAX_TAX_BPS) revert InvalidTaxRate(sellTaxBps);
        if (buyTaxBps == 0 && sellTaxBps == 0) revert NoTaxConfigured();

        PoolId id = key.toId();
        _config = TaxConfig({
            poolId: id,
            collector: collector,
            taxToken: taxToken,
            lpFee: key.fee,
            buyTaxBps: buyTaxBps,
            sellTaxBps: sellTaxBps,
            initialized: true
        });

        tick = poolManager.initialize(key, sqrtPriceX96);
        emit PoolTaxConfiguredV2(id, collector, taxToken, key.fee, buyTaxBps, sellTaxBps);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        TaxConfig memory cfg = _config;
        if (!cfg.initialized || sender != address(this)) revert UnauthorizedPoolInitialization();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(cfg.poolId)) revert WrongPool();
        return IHooks.beforeInitialize.selector;
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        TaxConfig memory cfg = _config;
        PoolId id = key.toId();
        if (!cfg.initialized || PoolId.unwrap(id) != PoolId.unwrap(cfg.poolId)) revert WrongPool();

        Currency outputCurrency = params.zeroForOne ? key.currency1 : key.currency0;
        bool isBuy = Currency.unwrap(outputCurrency) == cfg.taxToken;
        uint16 taxBps = isBuy ? cfg.buyTaxBps : cfg.sellTaxBps;
        if (taxBps == 0) return (IHooks.afterSwap.selector, 0);

        bool specifiedTokenIs0 = (params.amountSpecified < 0) == params.zeroForOne;
        Currency feeCurrency = specifiedTokenIs0 ? key.currency1 : key.currency0;
        int128 rawUnspecified = specifiedTokenIs0 ? delta.amount1() : delta.amount0();
        uint256 baseAmount = _absolute(rawUnspecified);

        uint256 feeAmount;
        if (params.amountSpecified < 0) {
            feeAmount = (baseAmount * taxBps) / BPS_DENOMINATOR;
        } else {
            feeAmount = (baseAmount * taxBps) / (BPS_DENOMINATOR - taxBps);
        }

        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);
        poolManager.take(feeCurrency, cfg.collector, feeAmount);
        emit TaxCollected(id, cfg.collector, Currency.unwrap(feeCurrency), feeAmount, isBuy, taxBps);
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    function _absolute(int128 value) private pure returns (uint256) {
        if (value >= 0) return uint256(value.toUint128());
        return uint256((-(value + 1)).toUint128()) + 1;
    }
}
