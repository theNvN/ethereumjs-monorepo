import { Block } from '@ethereumjs/block'
import { Transaction } from '@ethereumjs/tx'
import { BN, toBuffer } from 'ethereumjs-util'
import { dummy } from './helpers'

export function mockBlockchain(options: any = {}) {
  const number = options.number ?? '0x444444'
  const blockHash =
    options.hash ?? '0x910abca1728c53e8d6df870dd7af5352e974357dc58205dea1676be17ba6becf'
  const transactions = options.transactions ?? [Transaction.fromTxData({}).sign(dummy.privKey)]
  const block = {
    hash: () => toBuffer(blockHash),
    header: {
      number: new BN(toBuffer(number)),
    },
    toJSON: () => ({
      ...Block.fromBlockData({ header: { number } }).toJSON(),
      hash: options.hash ?? blockHash,
      transactions: transactions.map((t: Transaction) => t.toJSON()),
    }),
    transactions,
    uncleHeaders: [],
  }
  return {
    blocks: { latest: block },
    getBlock: async (val: any) => {
      if (Buffer.isBuffer(val) && val.equals(Buffer.alloc(32))) {
        throw Error
      }
      return block
    },
    getLatestHeader: () => {
      return Block.fromBlockData().header
    },
  }
}
