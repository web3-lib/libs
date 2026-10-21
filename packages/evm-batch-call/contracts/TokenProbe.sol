// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRouter {
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external;
}

interface IERC20 {
    function balanceOf(address owner) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice 代币风险探测：只在 eth_call 里以 deployless 方式执行（构造函数跑完把结果作为“代码”返回），不部署、不发交易。
/// 用附带的主币通过 V2 Router 买入，把一部分转给一个新地址，再把剩下的卖回主币，分别记录报价和实际数量，用来算买入税、转账税、卖出税，
/// 以及能不能卖（貔貅盘）。每一步失败都不影响返回结果，失败的步骤在 stage 里标出。
contract TokenProbe {
    struct Result {
        uint256 stage;
        uint256 buyQuote;
        uint256 bought;
        uint256 transferSent;
        uint256 transferReceived;
        uint256 sellAmount;
        uint256 sellQuote;
        uint256 sold;
        uint256 buyGas;
        uint256 sellGas;
        /// 卖出时池子实际收到的代币（扣掉卖出税之后的）
        uint256 pairReceived;
    }

    /// stage：0 全部完成；1 买入失败；2 转账失败；3 授权失败；4 卖出失败
    constructor(address router, address token, address pair) payable {
        Result memory r;
        address weth = IRouter(router).WETH();
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = token;
        try IRouter(router).getAmountsOut(msg.value, path) returns (uint256[] memory amounts) {
            r.buyQuote = amounts[1];
        } catch {}

        uint256 gasBefore = gasleft();
        try IRouter(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(0, path, address(this), block.timestamp) {
            r.buyGas = gasBefore - gasleft();
            r.bought = IERC20(token).balanceOf(address(this));
        } catch {
            r.stage = 1;
        }

        // 几乎没买到（买入税接近 100%）时跳过转账这一步（转 0 个可能失败，阶段会被误标），直接试卖出
        if (r.stage == 0 && r.bought >= 10) {
            // 转一成给一个没用过的地址，看对方实际收到多少
            address receiver = address(uint160(uint256(keccak256(abi.encode(address(this), token)))));
            r.transferSent = r.bought / 10;
            if (_call(token, abi.encodeWithSelector(IERC20.transfer.selector, receiver, r.transferSent))) {
                r.transferReceived = IERC20(token).balanceOf(receiver);
            } else {
                r.stage = 2;
            }
        }

        if (r.stage == 0) {
            r.sellAmount = IERC20(token).balanceOf(address(this));
            if (!_call(token, abi.encodeWithSelector(IERC20.approve.selector, router, type(uint256).max))) {
                r.stage = 3;
            }
        }

        if (r.stage == 0) {
            path[0] = token;
            path[1] = weth;
            try IRouter(router).getAmountsOut(r.sellAmount, path) returns (uint256[] memory amounts) {
                r.sellQuote = amounts[1];
            } catch {}
            uint256 balanceBefore = address(this).balance;
            uint256 pairBefore = IERC20(token).balanceOf(pair);
            gasBefore = gasleft();
            try IRouter(router).swapExactTokensForETHSupportingFeeOnTransferTokens(r.sellAmount, 0, path, address(this), block.timestamp) {
                r.sellGas = gasBefore - gasleft();
                r.sold = address(this).balance - balanceBefore;
                r.pairReceived = IERC20(token).balanceOf(pair) - pairBefore;
            } catch {
                r.stage = 4;
            }
        }

        bytes memory result = abi.encode(r);
        assembly {
            return(add(result, 32), mload(result))
        }
    }

    /// 调用 transfer / approve：成功且（没有返回值或返回 true）。USDT 等不返回 bool 的代币也算成功
    function _call(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }
}
