// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * 不需要部署的 Multicall3：字节码 + 构造参数作为合约创建 eth_call 发出，构造函数里执行全部调用并带回结果。
 *
 * 与 ethcall 自带的 deployless 字节码相比：
 * - 对 `MULTICALL3.getEthBalance(addr)` 的调用在构造函数里直接用 BALANCE 读取，
 *   主币余额和合约调用在同一次 eth_call 里完成（链上没有 Multicall3 时也一样）
 * - 结果超过 EIP-170 的 24KB 时，合约创建会因 "max code size exceeded" 失败，
 *   此时改为通过 revert Aggregate3Result(...) 带回（revert 数据没有大小限制）
 *
 * 编译：pnpm build:contracts（evmVersion=paris，不使用 PUSH0，兼容老链与 Tron TVM）
 */
contract DeploylessMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    /// 主币余额查询的约定目标地址（即 Multicall3 的标准地址）
    address private constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    /// getEthBalance(address)
    bytes4 private constant GET_ETH_BALANCE = 0x4d2301cc;
    /// EIP-170
    uint256 private constant MAX_CODE_SIZE = 24576;

    /// 结果过大时以此 revert 带回，客户端识别 selector 后按 aggregate3 的返回格式解码
    error Aggregate3Result(Result[] returnData);

    constructor(Call3[] memory calls) payable {
        uint256 length = calls.length;
        Result[] memory results = new Result[](length);
        for (uint256 i; i < length; ++i) {
            Call3 memory c = calls[i];
            bytes memory data = c.callData;
            if (c.target == MULTICALL3 && data.length == 36 && bytes4(data) == GET_ETH_BALANCE) {
                address account;
                assembly {
                    account := and(mload(add(data, 36)), 0xffffffffffffffffffffffffffffffffffffffff)
                }
                results[i] = Result(true, abi.encode(account.balance));
            } else {
                (bool success, bytes memory ret) = c.target.call(data);
                if (!success && !c.allowFailure) {
                    revert("Multicall3: call failed");
                }
                results[i] = Result(success, ret);
            }
        }

        bytes memory out = abi.encode(results);
        if (out.length > MAX_CODE_SIZE) {
            revert Aggregate3Result(results);
        }
        assembly {
            return(add(out, 32), mload(out))
        }
    }
}
