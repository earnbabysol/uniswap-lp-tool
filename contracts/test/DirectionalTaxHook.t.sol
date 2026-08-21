// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {DirectionalTaxHook} from "../src/DirectionalTaxHook.sol";
import {DirectionalTaxHookFactory} from "../src/DirectionalTaxHookFactory.sol";

contract DirectionalTaxHookTest is Deployers {
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;

    DirectionalTaxHookFactory internal factory;
    DirectionalTaxHook internal hook;
    PoolKey internal taxKey;
    PoolId internal taxPoolId;

    address internal creator;
    address internal trader;

    uint16 internal constant BUY_TAX_BPS = 100;
    uint16 internal constant SELL_TAX_BPS = 300;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        creator = makeAddr("creator");
        trader = makeAddr("trader");
        factory = new DirectionalTaxHookFactory(manager);

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
            60,
            SQRT_PRICE_1_1,
            Currency.unwrap(currency0),
            BUY_TAX_BPS,
            SELL_TAX_BPS,
            salt
        );
        hook = DirectionalTaxHook(hookAddress);
        taxKey = PoolKey(currency0, currency1, 0, 60, IHooks(hookAddress));
        taxPoolId = id;

        modifyLiquidityRouter.modifyLiquidity(taxKey, LIQUIDITY_PARAMS, ZERO_BYTES);
    }

    function testFactoryCreatesFlaggedImmutablePool() public view {
        assertEq(
            uint160(address(hook)) & factory.ALL_HOOK_MASK(),
            factory.REQUIRED_FLAGS(),
            "wrong hook permission bits"
        );
        assertEq(PoolId.unwrap(taxKey.toId()), PoolId.unwrap(taxPoolId));

        (bytes32 id, address collector, address taxToken, uint16 buyBps, uint16 sellBps, bool initialized) =
            hook.config();
        assertEq(id, PoolId.unwrap(taxPoolId));
        assertEq(collector, creator);
        assertEq(taxToken, Currency.unwrap(currency0));
        assertEq(buyBps, BUY_TAX_BPS);
        assertEq(sellBps, SELL_TAX_BPS);
        assertTrue(initialized);
        assertEq(taxKey.fee, 0);
    }

    function testConfigCannotBeChanged() public {
        vm.prank(address(factory));
        vm.expectRevert(DirectionalTaxHook.AlreadyConfigured.selector);
        hook.configureAndInitialize(
            taxKey,
            SQRT_PRICE_1_1,
            Currency.unwrap(currency0),
            500,
            500,
            creator
        );
    }

    function testCreatorNamespacingPreventsCopiedSaltTheft() public view {
        bytes32 salt = bytes32(uint256(12345));
        address attacker = address(0xBAD);
        assertNotEq(factory.derivedSalt(creator, salt), factory.derivedSalt(attacker, salt));
        assertNotEq(factory.predictHook(creator, salt), factory.predictHook(attacker, salt));
    }

    function testRejectsNonPresetRate() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(DirectionalTaxHookFactory.InvalidTaxRate.selector, uint16(250)));
        factory.createPool(
            currency0,
            currency1,
            60,
            SQRT_PRICE_1_1,
            Currency.unwrap(currency0),
            250,
            250,
            bytes32(uint256(1))
        );
    }

    function testExactInputSellChargesSellRateOnOutput() public {
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency1)).balanceOf(creator);

        vm.prank(trader);
        BalanceDelta result = swap(taxKey, true, -10 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency1)).balanceOf(creator) - beforeCollector;
        uint256 netOutput = uint256(uint128(result.amount1()));
        uint256 grossOutput = netOutput + fee;
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / grossOutput, SELL_TAX_BPS, 1);
    }

    function testExactInputBuyChargesBuyRateOnProjectTokenOutput() public {
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency0)).balanceOf(creator);

        vm.prank(trader);
        BalanceDelta result = swap(taxKey, false, -10 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency0)).balanceOf(creator) - beforeCollector;
        uint256 netOutput = uint256(uint128(result.amount0()));
        uint256 grossOutput = netOutput + fee;
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / grossOutput, BUY_TAX_BPS, 1);
    }

    function testExactOutputGrossUpKeepsEffectiveSellRate() public {
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency0)).balanceOf(creator);

        vm.prank(trader);
        BalanceDelta result = swap(taxKey, true, 1 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency0)).balanceOf(creator) - beforeCollector;
        uint256 totalInput = uint256(-int256(result.amount0()));
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / totalInput, SELL_TAX_BPS, 1);
    }

    function testHighRiskPresetStillSettlesAndIsVisible() public {
        address secondCreator = makeAddr("high-tax-creator");
        bytes32 salt = _mineSalt(secondCreator, 100_000);
        vm.prank(secondCreator);
        (address secondHook,,) = factory.createPool(
            currency0,
            currency1,
            1,
            SQRT_PRICE_1_1,
            Currency.unwrap(currency1),
            8_000,
            8_000,
            salt
        );
        (,,, uint16 buyBps, uint16 sellBps, bool initialized) = DirectionalTaxHook(secondHook).config();
        assertEq(buyBps, 8_000);
        assertEq(sellBps, 8_000);
        assertTrue(initialized);

        PoolKey memory highTaxKey = PoolKey(currency0, currency1, 0, 1, IHooks(secondHook));
        modifyLiquidityRouter.modifyLiquidity(highTaxKey, LIQUIDITY_PARAMS, ZERO_BYTES);
        uint256 beforeCollector = MockERC20(Currency.unwrap(currency1)).balanceOf(secondCreator);

        vm.prank(trader);
        BalanceDelta result = swap(highTaxKey, true, -10 ether, ZERO_BYTES);

        uint256 fee = MockERC20(Currency.unwrap(currency1)).balanceOf(secondCreator) - beforeCollector;
        uint256 netOutput = uint256(uint128(result.amount1()));
        uint256 grossOutput = netOutput + fee;
        assertGt(fee, 0);
        assertApproxEqAbs((fee * 10_000) / grossOutput, 8_000, 1);
    }

    function testFuzzPresetValidationNeverAcceptsArbitraryRate(uint16 bps) public {
        bool allowed = bps == 0 || bps == 100 || bps == 300 || bps == 500 || bps == 1_000
            || bps == 2_000 || bps == 3_000 || bps == 5_000 || bps == 8_000;
        if (allowed) return;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(DirectionalTaxHookFactory.InvalidTaxRate.selector, bps));
        factory.createPool(
            currency0,
            currency1,
            60,
            SQRT_PRICE_1_1,
            Currency.unwrap(currency0),
            bps,
            bps,
            bytes32(uint256(bps))
        );
    }

    function _mineSalt(address owner, uint256 start) internal view returns (bytes32 userSalt) {
        for (uint256 i = start; i < start + 250_000; i++) {
            userSalt = bytes32(i);
            if (factory.hasRequiredFlags(factory.predictHook(owner, userSalt))) return userSalt;
        }
        revert("unable to mine hook salt");
    }
}
