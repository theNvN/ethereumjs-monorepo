import {
  addressToBuffer,
  divCeil,
  maxCallGas,
  setLengthLeftStorage,
  subMemUsage,
  trap,
  updateSstoreGas,
} from '.'
import { Address, bigIntToBuffer, setLengthLeft } from 'ethereumjs-util'
import { ERROR } from '../../exceptions'
import { RunState } from '../interpreter'
import Common, { Hardfork } from '@ethereumjs/common'
import { updateSstoreGasEIP1283 } from './EIP1283'
import { updateSstoreGasEIP2200 } from './EIP2200'
import { accessAddressEIP2929, accessStorageEIP2929 } from './EIP2929'

/**
 * This file returns the dynamic parts of opcodes which have dynamic gas
 * These are not pure functions: some edit the size of the memory
 * These functions are therefore not read-only
 */

// The dynamic gas handler methods take a runState and a gas BN
// The gas BN is necessary, since the base fee needs to be included,
// to calculate the max call gas for the call opcodes correctly.
export interface AsyncDynamicGasHandler {
  (runState: RunState, gas: bigint, common: Common): Promise<bigint>
}

export interface SyncDynamicGasHandler {
  (runState: RunState, gas: bigint, common: Common): bigint
}

export const dynamicGasHandlers: Map<number, AsyncDynamicGasHandler | SyncDynamicGasHandler> =
  new Map<number, AsyncDynamicGasHandler>([
    [
      /* SHA3 */
      0x20,
      async function (runState, gas, common): Promise<bigint> {
        const [offset, length] = runState.stack.peek(2)
        gas += subMemUsage(runState, offset, length, common)
        gas += BigInt(common.param('gasPrices', 'sha3Word')) * divCeil(length, BigInt(32))
        return gas
      },
    ],
    [
      /* BALANCE */
      0x31,
      async function (runState, gas, common): Promise<bigint> {
        if (common.isActivatedEIP(2929)) {
          const addressBigInt = runState.stack.peek()[0]
          const address = new Address(addressToBuffer(addressBigInt))
          gas += accessAddressEIP2929(runState, address, common)
        }
        return gas
      },
    ],
    [
      /* CALLDATACOPY */
      0x37,
      async function (runState, gas, common): Promise<bigint> {
        const [memOffset, _dataOffset, dataLength] = runState.stack.peek(3)

        gas += subMemUsage(runState, memOffset, dataLength, common)
        if (dataLength !== BigInt(0)) {
          gas += BigInt(common.param('gasPrices', 'copy')) * divCeil(dataLength, BigInt(32))
        }
        return gas
      },
    ],
    [
      /* CODECOPY */
      0x39,
      async function (runState, gas, common): Promise<bigint> {
        const [memOffset, _codeOffset, dataLength] = runState.stack.peek(3)

        gas += subMemUsage(runState, memOffset, dataLength, common)
        if (dataLength !== BigInt(0)) {
          gas += BigInt(common.param('gasPrices', 'copy')) * divCeil(dataLength, BigInt(32))
        }
        return gas
      },
    ],
    [
      /* EXTCODESIZE */
      0x3b,
      async function (runState, gas, common): Promise<bigint> {
        if (common.isActivatedEIP(2929)) {
          const addressBigInt = runState.stack.peek()[0]
          const address = new Address(addressToBuffer(addressBigInt))
          gas += accessAddressEIP2929(runState, address, common)
        }
        return gas
      },
    ],
    [
      /* EXTCODECOPY */
      0x3c,
      async function (runState, gas, common): Promise<bigint> {
        const [addressBigInt, memOffset, _codeOffset, dataLength] = runState.stack.peek(4)

        gas += subMemUsage(runState, memOffset, dataLength, common)

        if (common.isActivatedEIP(2929)) {
          const address = new Address(addressToBuffer(addressBigInt))
          gas += accessAddressEIP2929(runState, address, common)
        }

        if (dataLength !== BigInt(0)) {
          gas += BigInt(common.param('gasPrices', 'copy')) * divCeil(dataLength, BigInt(32))
        }
        return gas
      },
    ],
    [
      /* RETURNDATACOPY */
      0x3e,
      async function (runState, gas, common): Promise<bigint> {
        const [memOffset, returnDataOffset, dataLength] = runState.stack.peek(3)

        if (returnDataOffset + dataLength > runState.eei.getReturnDataSize()) {
          trap(ERROR.OUT_OF_GAS)
        }

        gas += subMemUsage(runState, memOffset, dataLength, common)

        if (dataLength !== BigInt(0)) {
          gas += BigInt(common.param('gasPrices', 'copy')) * divCeil(dataLength, BigInt(32))
        }
        return gas
      },
    ],
    [
      /* EXTCODEHASH */
      0x3f,
      async function (runState, gas, common): Promise<bigint> {
        if (common.isActivatedEIP(2929)) {
          const addressBigInt = runState.stack.peek()[0]
          const address = new Address(addressToBuffer(addressBigInt))
          gas += accessAddressEIP2929(runState, address, common)
        }
        return gas
      },
    ],
    [
      /* MLOAD */
      0x51,
      async function (runState, gas, common): Promise<bigint> {
        const pos = runState.stack.peek()[0]
        gas += subMemUsage(runState, pos, BigInt(32), common)
        return gas
      },
    ],
    [
      /* MSTORE */
      0x52,
      async function (runState, gas, common): Promise<bigint> {
        const offset = runState.stack.peek()[0]
        gas += subMemUsage(runState, offset, BigInt(32), common)
        return gas
      },
    ],
    [
      /* MSTORE8 */
      0x53,
      async function (runState, gas, common): Promise<bigint> {
        const offset = runState.stack.peek()[0]
        gas += subMemUsage(runState, offset, BigInt(1), common)
        return gas
      },
    ],
    [
      /* SLOAD */
      0x54,
      async function (runState, gas, common): Promise<bigint> {
        const key = runState.stack.peek()[0]
        const keyBuf = setLengthLeft(bigIntToBuffer(key), 32)

        if (common.isActivatedEIP(2929)) {
          gas += accessStorageEIP2929(runState, keyBuf, false, common)
        }
        return gas
      },
    ],
    [
      /* SSTORE */
      0x55,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.eei.isStatic()) {
          trap(ERROR.STATIC_STATE_CHANGE)
        }
        const [key, val] = runState.stack.peek(2)

        const keyBuf = setLengthLeft(bigIntToBuffer(key), 32)
        // NOTE: this should be the shortest representation
        let value
        if (val === BigInt(0)) {
          value = Buffer.from([])
        } else {
          value = bigIntToBuffer(val)
        }

        const currentStorage = setLengthLeftStorage(await runState.eei.storageLoad(keyBuf))
        const originalStorage = setLengthLeftStorage(await runState.eei.storageLoad(keyBuf, true))
        if (common.hardfork() === Hardfork.Constantinople) {
          gas += updateSstoreGasEIP1283(
            runState,
            currentStorage,
            originalStorage,
            setLengthLeftStorage(value),
            common
          )
        } else if (common.gteHardfork(Hardfork.Istanbul)) {
          gas += updateSstoreGasEIP2200(
            runState,
            currentStorage,
            originalStorage,
            setLengthLeftStorage(value),
            keyBuf,
            common
          )
        } else {
          gas += updateSstoreGas(runState, currentStorage, setLengthLeftStorage(value), common)
        }

        if (common.isActivatedEIP(2929)) {
          // We have to do this after the Istanbul (EIP2200) checks.
          // Otherwise, we might run out of gas, due to "sentry check" of 2300 gas,
          // if we deduct extra gas first.
          gas += accessStorageEIP2929(runState, keyBuf, true, common)
        }
        return gas
      },
    ],
    [
      /* LOG */
      0xa0,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.eei.isStatic()) {
          trap(ERROR.STATIC_STATE_CHANGE)
        }

        const [memOffset, memLength] = runState.stack.peek(2)

        const topicsCount = runState.opCode - 0xa0

        if (topicsCount < 0 || topicsCount > 4) {
          trap(ERROR.OUT_OF_RANGE)
        }

        gas += subMemUsage(runState, memOffset, memLength, common)
        gas +=
          BigInt(common.param('gasPrices', 'logTopic')) * BigInt(topicsCount) +
          memLength * BigInt(common.param('gasPrices', 'logData'))
        return gas
      },
    ],
    [
      /* CREATE */
      0xf0,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.eei.isStatic()) {
          trap(ERROR.STATIC_STATE_CHANGE)
        }
        const [_value, offset, length] = runState.stack.peek(3)

        if (common.isActivatedEIP(2929)) {
          gas += accessAddressEIP2929(runState, runState.eei.getAddress(), common, false)
        }

        gas += subMemUsage(runState, offset, length, common)

        let gasLimit = BigInt(runState.eei.getGasLeft()) - gas
        gasLimit = maxCallGas(gasLimit, gasLimit, runState, common)

        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* CALL */
      0xf1,
      async function (runState, gas, common): Promise<bigint> {
        const [currentGasLimit, toAddr, value, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(7)
        const toAddress = new Address(addressToBuffer(toAddr))

        if (runState.eei.isStatic() && value !== BigInt(0)) {
          trap(ERROR.STATIC_STATE_CHANGE)
        }
        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)
        if (common.isActivatedEIP(2929)) {
          gas += accessAddressEIP2929(runState, toAddress, common)
        }

        if (value !== BigInt(0)) {
          gas += BigInt(common.param('gasPrices', 'callValueTransfer'))
        }

        if (common.gteHardfork(Hardfork.SpuriousDragon)) {
          // We are at or after Spurious Dragon
          // Call new account gas: account is DEAD and we transfer nonzero value
          if ((await runState.eei.isAccountEmpty(toAddress)) && !(value === BigInt(0))) {
            gas += BigInt(common.param('gasPrices', 'callNewAccount'))
          }
        } else if (!(await runState.eei.accountExists(toAddress))) {
          // We are before Spurious Dragon and the account does not exist.
          // Call new account gas: account does not exist (it is not in the state trie, not even as an "empty" account)
          gas += BigInt(common.param('gasPrices', 'callNewAccount'))
        }

        let gasLimit = maxCallGas(
          currentGasLimit,
          runState.eei.getGasLeft() - gas,
          runState,
          common
        )
        // note that TangerineWhistle or later this cannot happen
        // (it could have ran out of gas prior to getting here though)
        if (gasLimit > runState.eei.getGasLeft() - gas) {
          trap(ERROR.OUT_OF_GAS)
        }

        if (gas > runState.eei.getGasLeft()) {
          trap(ERROR.OUT_OF_GAS)
        }

        if (value !== BigInt(0)) {
          const callStipend = BigInt(common.param('gasPrices', 'callStipend'))
          runState.eei.addStipend(callStipend)
          gasLimit += callStipend
        }

        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* CALLCODE */
      0xf2,
      async function (runState, gas, common): Promise<bigint> {
        const [currentGasLimit, toAddr, value, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(7)

        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        if (common.isActivatedEIP(2929)) {
          const toAddress = new Address(addressToBuffer(toAddr))
          gas += accessAddressEIP2929(runState, toAddress, common)
        }

        if (value !== BigInt(0)) {
          gas += BigInt(common.param('gasPrices', 'callValueTransfer'))
        }
        let gasLimit = maxCallGas(
          currentGasLimit,
          runState.eei.getGasLeft() - gas,
          runState,
          common
        )
        // note that TangerineWhistle or later this cannot happen
        // (it could have ran out of gas prior to getting here though)
        if (gasLimit > runState.eei.getGasLeft() - gas) {
          trap(ERROR.OUT_OF_GAS)
        }
        if (value !== BigInt(0)) {
          const callStipend = BigInt(common.param('gasPrices', 'callStipend'))
          runState.eei.addStipend(callStipend)
          gasLimit += callStipend
        }

        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* RETURN */
      0xf3,
      async function (runState, gas, common): Promise<bigint> {
        const [offset, length] = runState.stack.peek(2)
        gas += subMemUsage(runState, offset, length, common)
        return gas
      },
    ],
    [
      /* DELEGATECALL */
      0xf4,
      async function (runState, gas, common): Promise<bigint> {
        const [currentGasLimit, toAddr, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(6)

        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        if (common.isActivatedEIP(2929)) {
          const toAddress = new Address(addressToBuffer(toAddr))
          gas += accessAddressEIP2929(runState, toAddress, common)
        }

        const gasLimit = maxCallGas(
          currentGasLimit,
          runState.eei.getGasLeft() - gas,
          runState,
          common
        )
        // note that TangerineWhistle or later this cannot happen
        // (it could have ran out of gas prior to getting here though)
        if (gasLimit > runState.eei.getGasLeft() - gas) {
          trap(ERROR.OUT_OF_GAS)
        }

        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* CREATE2 */
      0xf5,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.eei.isStatic()) {
          trap(ERROR.STATIC_STATE_CHANGE)
        }

        const [_value, offset, length, _salt] = runState.stack.peek(4)

        gas += subMemUsage(runState, offset, length, common)

        if (common.isActivatedEIP(2929)) {
          gas += accessAddressEIP2929(runState, runState.eei.getAddress(), common, false)
        }

        gas += BigInt(common.param('gasPrices', 'sha3Word')) * divCeil(length, BigInt(32))
        let gasLimit = runState.eei.getGasLeft() - gas
        gasLimit = maxCallGas(gasLimit, gasLimit, runState, common) // CREATE2 is only available after TangerineWhistle (Constantinople introduced this opcode)
        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* AUTH */
      0xf6,
      async function (runState, gas, common): Promise<bigint> {
        const [_address, memOffset, memLength] = runState.stack.peek(3)
        gas += subMemUsage(runState, memOffset, memLength, common)
        return gas
      },
    ],
    [
      /* AUTHCALL */
      0xf7,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.eei._env.auth === undefined) {
          trap(ERROR.AUTHCALL_UNSET)
        }

        const [
          currentGasLimit,
          addr,
          value,
          valueExt,
          argsOffset,
          argsLength,
          retOffset,
          retLength,
        ] = runState.stack.peek(8)

        if (valueExt !== 0n) {
          trap(ERROR.AUTHCALL_NONZERO_VALUEEXT)
        }

        const toAddress = new Address(addressToBuffer(addr))

        gas += BigInt(common.param('gasPrices', 'warmstorageread'))

        gas += accessAddressEIP2929(runState, toAddress, common, true, true)

        gas += subMemUsage(runState, argsOffset, argsLength, common)
        gas += subMemUsage(runState, retOffset, retLength, common)

        if (value > BigInt(0)) {
          gas += BigInt(common.param('gasPrices', 'authcallValueTransfer'))
          const account = await runState.vmState.getAccount(toAddress)
          if (account.isEmpty()) {
            gas += BigInt(common.param('gasPrices', 'callNewAccount'))
          }
        }

        let gasLimit = maxCallGas(
          runState.eei.getGasLeft() - gas,
          runState.eei.getGasLeft() - gas,
          runState,
          common
        )
        if (currentGasLimit !== BigInt(0)) {
          if (currentGasLimit > gasLimit) {
            trap(ERROR.OUT_OF_GAS)
          }
          gasLimit = currentGasLimit
        }

        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* STATICCALL */
      0xfa,
      async function (runState, gas, common): Promise<bigint> {
        const [currentGasLimit, toAddr, inOffset, inLength, outOffset, outLength] =
          runState.stack.peek(6)

        gas += subMemUsage(runState, inOffset, inLength, common)
        gas += subMemUsage(runState, outOffset, outLength, common)

        if (common.isActivatedEIP(2929)) {
          const toAddress = new Address(addressToBuffer(toAddr))
          gas += accessAddressEIP2929(runState, toAddress, common)
        }

        const gasLimit = maxCallGas(
          currentGasLimit,
          runState.eei.getGasLeft() - gas,
          runState,
          common
        ) // we set TangerineWhistle or later to true here, as STATICCALL was available from Byzantium (which is after TangerineWhistle)

        runState.messageGasLimit = gasLimit
        return gas
      },
    ],
    [
      /* REVERT */
      0xfd,
      async function (runState, gas, common): Promise<bigint> {
        const [offset, length] = runState.stack.peek(2)
        gas += subMemUsage(runState, offset, length, common)
        return gas
      },
    ],
    [
      /* SELFDESTRUCT */
      0xff,
      async function (runState, gas, common): Promise<bigint> {
        if (runState.eei.isStatic()) {
          trap(ERROR.STATIC_STATE_CHANGE)
        }
        const selfdestructToaddressBigInt = runState.stack.peek()[0]

        const selfdestructToAddress = new Address(addressToBuffer(selfdestructToaddressBigInt))
        let deductGas = false
        if (common.gteHardfork(Hardfork.SpuriousDragon)) {
          // EIP-161: State Trie Clearing
          const balance = await runState.eei.getExternalBalance(runState.eei.getAddress())
          if (balance > BigInt(0)) {
            // This technically checks if account is empty or non-existent
            // TODO: improve on the API here (EEI and StateManager)
            const empty = await runState.eei.isAccountEmpty(selfdestructToAddress)
            if (empty) {
              deductGas = true
            }
          }
        } else if (common.gteHardfork(Hardfork.TangerineWhistle)) {
          // EIP-150 (Tangerine Whistle) gas semantics
          const exists = await runState.vmState.accountExists(selfdestructToAddress)
          if (!exists) {
            deductGas = true
          }
        }
        if (deductGas) {
          gas += BigInt(common.param('gasPrices', 'callNewAccount'))
        }

        if (common.isActivatedEIP(2929)) {
          gas += accessAddressEIP2929(runState, selfdestructToAddress, common, true, true)
        }
        return gas
      },
    ],
  ])

// Set the range [0xa0, 0xa4] to the LOG handler
const logDynamicFunc = dynamicGasHandlers.get(0xa0)!
for (let i = 0xa1; i <= 0xa4; i++) {
  dynamicGasHandlers.set(i, logDynamicFunc)
}
