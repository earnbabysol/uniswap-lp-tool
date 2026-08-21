// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {ConfigurableTaxHookV2} from "../src/ConfigurableTaxHookV2.sol";
import {ConfigurableTaxHookFactoryV2} from "../src/ConfigurableTaxHookFactoryV2.sol";

contract ConfigurableTaxHookV2Test is Deployers {
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;

    ConfigurableTaxHookFactoryV2 internal factory;
    ConfigurableTaxHookV2 internal hook;
    PoolKey internal taxKey;
    PoolId internal taxPoolId;

    address internal creator;
    address internal trader;

    uint24 internal constant LP_FEE = 3_000;
    uint16 internal constant BUY_TAX_BPS = 125;
    uint16 internal constant SELL_TAX_BPS = 275;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        creator = makeAddr("v2-creator");
        trader = makeAddr("v2-trader");
        factory = new ConfigurableTaxHookFactoryV2(manager);

        MockERC20(Currency.unwrap(currency0)).mint(trader, 1_000_000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(trader, 1_000_000 ether);
        vm.startPrank(trader);
        MockERC20(Currency.unwrap(currency0)).approve(address(swapRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        bytes32 salt = _mineSalt(creator, 0);
        vm.prank(creator);
        (address hookAddress, PoolId id,) = factory.createPool(
            currency0,
            currency1,
            LP_FEE,
            60,
            SQRT_PRICE_1_1,
            Currency.unwrap(currency0),
            BUY_TAX_BPS,
            SELL_TAX_BPS,
            salt
        );
        hook = ConfigurableTaxHookV2(hookAddress);
        taxKey = PoolKey(currency0, currency1, LP_FEE, 60, IHooks(hookAddress));
        taxPoolId = id;

        modifyLiquidityRouter.modifyLiquidity(taxKey, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    function testStoresCustomLpFeeAndIndependentTaxes() public view {
        assertEq(
            uint160(address(hook)) & factory.ALL_HOOK_MASK(), factory.REQUIRED_FLAGS(), "wrong hook permission bits"
        );
        assertEq(PoolId.unwrap(taxKey.toId()), PoolId.unwrap(taxPoolId));

        (
            bytes32 id,
            address collector,
            address taxToken,
            uint24 lpFee,
            uint16 buyBps,
            uint16 sellBps,
            bool initialized
        ) = hook.config();
        assertEq(id, PoolId.unwrap(taxPoolId));
        assertEq(collector, creator);
        assertEq(taxToken, Currency.unwrap(currency0));
        assertEq(lpFee, LP_FEE);
        assertEq(buyBps, BUY_TAX_BPS);
        assertEq(sellBps, SELL_TAX_BPS);
        assertTrue(initialized);
    }

    function testExactInputSellUsesCustomSellTaxAfterLpFee() public {
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency1)).balanceOf(creator);

        vm.prank(trader);
        BalanceDelta result = swap(taxKey, true, -10 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency1)).balanceOf(creator) - beforeCollector;
        uint256 netOutput = uint256(uint128(result.amount1()));
        uint256 grossOutput = netOutput + fee;
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / grossOutput, SELL_TAX_BPS, 1);
    }

    function testExactInputBuyUsesCustomBuyTaxAfterLpFee() public {
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency0)).balanceOf(creator);

        vm.prank(trader);
        BalanceDelta result = swap(taxKey, false, -10 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency0)).balanceOf(creator) - beforeCollector;
        uint256 netOutput = uint256(uint128(result.amount0()));
        uint256 grossOutput = netOutput + fee;
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / grossOutput, BUY_TAX_BPS, 1);
    }

    function testExactOutputSellGrossesUpCustomTax() public {
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency0)).balanceOf(creator);

        vm.prank(trader);
        BalanceDelta result = swap(taxKey, true, 1 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency0)).balanceOf(creator) - beforeCollector;
        uint256 totalInput = uint256(-int256(result.amount0()));
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / totalInput, SELL_TAX_BPS, 1);
    }

    function testExactOutputBuyGrossesUpCustomTax() public {
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency1)).balanceOf(creator);

        vm.prank(trader);
        BalanceDelta result = swap(taxKey, false, 1 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency1)).balanceOf(creator) - beforeCollector;
        uint256 totalInput = uint256(-int256(result.amount1()));
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / totalInput, BUY_TAX_BPS, 1);
    }

    function testAcceptsOneBasisPointAndAsymmetricZero() public {
        address secondCreator = makeAddr("v2-custom-creator");
        bytes32 salt = _mineSalt(secondCreator, 90_000);
        vm.prank(secondCreator);
        (address secondHook,,) =
            factory.createPool(currency0, currency1, 500, 10, SQRT_PRICE_1_1, Currency.unwrap(currency1), 1, 0, salt);
        (,,, uint24 lpFee, uint16 buyBps, uint16 sellBps, bool initialized) = ConfigurableTaxHookV2(secondHook).config();
        assertEq(lpFee, 500);
        assertEq(buyBps, 1);
        assertEq(sellBps, 0);
        assertTrue(initialized);
    }

    function testEightyPercentCustomTaxStillSettles() public {
        address highTaxCreator = makeAddr("v2-high-tax-creator");
        bytes32 salt = _mineSalt(highTaxCreator, 140_000);
        vm.prank(highTaxCreator);
        (address highTaxHook,,) = factory.createPool(
            currency0, currency1, 500, 10, SQRT_PRICE_1_1, Currency.unwrap(currency1), 8_000, 0, salt
        );
        PoolKey memory highTaxKey = PoolKey(currency0, currency1, 500, 10, IHooks(highTaxHook));
        modifyLiquidityRouter.modifyLiquidity(highTaxKey, LIQUIDITY_PARAMS, ZERO_BYTES);
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency1)).balanceOf(highTaxCreator);

        vm.prank(trader);
        BalanceDelta result = swap(highTaxKey, true, -10 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency1)).balanceOf(highTaxCreator) - beforeCollector;
        uint256 netOutput = uint256(uint128(result.amount1()));
        uint256 grossOutput = netOutput + fee;
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / grossOutput, 8_000, 1);
    }

    function testCreatorNamespacePreventsCopiedSalt() public view {
        bytes32 salt = bytes32(uint256(12345));
        address attacker = address(0xBAD);
        assertNotEq(factory.derivedSalt(creator, salt), factory.derivedSalt(attacker, salt));
        assertNotEq(factory.predictHook(creator, salt), factory.predictHook(attacker, salt));
    }

    function testRejectsTaxAboveEightyPercent() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ConfigurableTaxHookFactoryV2.InvalidTaxRate.selector, uint16(8_001)));
        factory.createPool(
            currency0, currency1, 500, 10, SQRT_PRICE_1_1, Currency.unwrap(currency0), 8_001, 0, bytes32(uint256(1))
        );
    }

    function testRejectsBothTaxesAtZero() public {
        vm.prank(creator);
        vm.expectRevert(ConfigurableTaxHookFactoryV2.NoTaxConfigured.selector);
        factory.createPool(
            currency0, currency1, 500, 10, SQRT_PRICE_1_1, Currency.unwrap(currency0), 0, 0, bytes32(uint256(2))
        );
    }

    function testRejectsLpFeeAboveV4Maximum() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ConfigurableTaxHookFactoryV2.InvalidLpFee.selector, uint24(1_000_001)));
        factory.createPool(
            currency0,
            currency1,
            1_000_001,
            10,
            SQRT_PRICE_1_1,
            Currency.unwrap(currency0),
            100,
            100,
            bytes32(uint256(3))
        );
    }

    function testConfigCannotBeChanged() public {
        vm.prank(address(factory));
        vm.expectRevert(ConfigurableTaxHookV2.AlreadyConfigured.selector);
        hook.configureAndInitialize(taxKey, SQRT_PRICE_1_1, Currency.unwrap(currency0), 500, 500, creator);
    }

    function _mineSalt(address owner, uint256 start) internal view returns (bytes32 userSalt) {
        for (uint256 i = start; i < start + 250_000; i++) {
            userSalt = bytes32(i);
            if (factory.hasRequiredFlags(factory.predictHook(owner, userSalt))) return userSalt;
        }
        revert("unable to mine v2 hook salt");
    }
}
