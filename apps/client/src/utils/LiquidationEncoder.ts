import { FLASHLOAN_FEE_BPS } from "@morpho-blue-liquidation-bot/config";
import { ExecutorEncoder } from "executooor-viem";
import type { Account, Address, Chain, Client, Hex, Transport } from "viem";
import { encodeAbiParameters, encodeFunctionData, parseUnits } from "viem";

import { preLiquidationAbi } from "../abis/PreLiquidation";

import { wMulDown } from "./maths";

const FLASHLOAN_FEE = parseUnits(FLASHLOAN_FEE_BPS.toString(), 14); // 0.04% scaled by WAD

export class LiquidationEncoder<
  client extends Client<Transport, Chain, Account> = Client<Transport, Chain, Account>,
> extends ExecutorEncoder<client> {
  public preLiquidate(
    preLiquidation: Address,
    borrower: Address,
    seizedAssets: bigint,
    repaidShares: bigint,
    callbackCalls?: Hex[],
  ) {
    this.pushCall(
      preLiquidation,
      0n,
      encodeFunctionData({
        abi: preLiquidationAbi,
        functionName: "preLiquidate",
        args: [
          borrower,
          seizedAssets,
          repaidShares,
          encodeAbiParameters(
            [{ type: "bytes[]" }, { type: "bytes" }],
            [callbackCalls ?? [], "0x"],
          ),
        ],
      }),
      {
        sender: preLiquidation,
        dataIndex: 1n, // onPreLiquidate(uint256,bytes)
      },
    );
  }

  public morphoBlueFlashLoan(
    morphoBlueAddress: Address,
    asset: Address,
    amount: bigint,
    callbackCalls?: Hex[],
  ) {
    callbackCalls ??= [];

    // Morpho Blue pulls back `amount + fee` at the end of the flash loan, so the
    // final callback call must approve the full repayment (unlike the executooor
    // helper `blueFlashLoan`, which only approves the principal).
    const fee = wMulDown(amount, FLASHLOAN_FEE);

    this.pushCall(
      morphoBlueAddress,
      0n,
      encodeFunctionData({
        abi: [
          {
            inputs: [
              { name: "asset", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "data", type: "bytes" },
            ],
            name: "flashLoan",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
        ],
        functionName: "flashLoan",
        args: [
          asset,
          amount,
          encodeAbiParameters(
            [{ type: "bytes[]" }, { type: "bytes" }],
            [
              callbackCalls.concat([
                ExecutorEncoder.buildErc20Approve(asset, morphoBlueAddress, amount + fee),
              ]),
              "0x",
            ],
          ),
        ],
      }),
      {
        sender: morphoBlueAddress,
        dataIndex: 1n, // onMorphoFlashLoan(uint256,bytes)
      },
    );
  }
}
