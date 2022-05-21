import Common, { Chain, Hardfork } from '@ethereumjs/common'
import { BN, rlp, TWO_POW256 } from 'ethereumjs-util'
import tape from 'tape'
import { FeeMarketEIP1559Transaction } from '../src'

const testdata = require('./json/eip1559.json') // Source: Besu

const common = new Common({
  chain: Chain.Rinkeby,
  hardfork: Hardfork.London,
})

const validAddress = Buffer.from('01'.repeat(20), 'hex')
const validSlot = Buffer.from('01'.repeat(32), 'hex')
const chainId = new BN(4)

tape('[FeeMarketEIP1559Transaction]', function (t) {
  t.test('cannot input decimal or negative values', (st) => {
    const values = [
      'maxFeePerGas',
      'maxPriorityFeePerGas',
      'chainId',
      'nonce',
      'gasLimit',
      'value',
      'v',
      'r',
      's',
    ]
    const cases = [
      10.1,
      '10.1',
      '0xaa.1',
      -10.1,
      -1,
      new BN(-10),
      '-100',
      '-10.1',
      '-0xaa',
      Infinity,
      -Infinity,
      NaN,
      {},
      true,
      false,
      () => {},
      Number.MAX_SAFE_INTEGER + 1,
    ]
    for (const value of values) {
      const txData: any = {}
      for (const testCase of cases) {
        if (!(value === 'chainId' && (isNaN(<number>testCase) || testCase === false))) {
          txData[value] = testCase
          st.throws(() => {
            FeeMarketEIP1559Transaction.fromTxData(txData)
          })
        }
      }
    }
    st.end()
  })

  t.test('getUpfrontCost()', function (st) {
    const tx = FeeMarketEIP1559Transaction.fromTxData(
      {
        maxFeePerGas: 10,
        maxPriorityFeePerGas: 8,
        gasLimit: 100,
        value: 6,
      },
      { common }
    )
    st.equals(tx.getUpfrontCost().toNumber(), 806, 'correct upfront cost with default base fee')
    let baseFee = new BN(0)
    st.equals(tx.getUpfrontCost(baseFee).toNumber(), 806, 'correct upfront cost with 0 base fee')
    baseFee = new BN(4)
    st.equals(
      tx.getUpfrontCost(baseFee).toNumber(),
      1006,
      'correct upfront cost with cost-changing base fee value'
    )
    st.end()
  })

  t.test('sign()', function (st) {
    for (let index = 0; index < testdata.length; index++) {
      const data = testdata[index]
      const pkey = Buffer.from(data.privateKey.slice(2), 'hex')
      const txn = FeeMarketEIP1559Transaction.fromTxData(data, { common })
      const signed = txn.sign(pkey)
      const rlpSerialized = rlp.encode(signed.serialize())
      st.ok(
        rlpSerialized.equals(Buffer.from(data.signedTransactionRLP.slice(2), 'hex')),
        'Should sign txs correctly'
      )
    }
    st.end()
  })

  t.test('hash()', function (st) {
    const data = testdata[0]
    const pkey = Buffer.from(data.privateKey.slice(2), 'hex')
    let txn = FeeMarketEIP1559Transaction.fromTxData(data, { common })
    let signed = txn.sign(pkey)
    const expectedHash = Buffer.from(
      '2e564c87eb4b40e7f469b2eec5aa5d18b0b46a24e8bf0919439cfb0e8fcae446',
      'hex'
    )
    st.ok(signed.hash().equals(expectedHash), 'Should provide the correct hash when frozen')
    txn = FeeMarketEIP1559Transaction.fromTxData(data, { common, freeze: false })
    signed = txn.sign(pkey)
    st.ok(signed.hash().equals(expectedHash), 'Should provide the correct hash when not frozen')
    st.end()
  })

  t.test('freeze property propagates from unsigned tx to signed tx', function (st) {
    const data = testdata[0]
    const pkey = Buffer.from(data.privateKey.slice(2), 'hex')
    const txn = FeeMarketEIP1559Transaction.fromTxData(data, { common, freeze: false })
    st.notOk(Object.isFrozen(txn), 'tx object is not frozen')
    const signedTxn = txn.sign(pkey)
    st.notOk(Object.isFrozen(signedTxn), 'tx object is not frozen')
    st.end()
  })

  t.test('common propagates from the common of tx, not the common in TxOptions', function (st) {
    const data = testdata[0]
    const pkey = Buffer.from(data.privateKey.slice(2), 'hex')
    const txn = FeeMarketEIP1559Transaction.fromTxData(data, { common, freeze: false })
    const newCommon = new Common({ chain: Chain.Rinkeby, hardfork: Hardfork.London, eips: [2537] })
    st.notDeepEqual(newCommon, common, 'new common is different than original common')
    Object.defineProperty(txn, 'common', {
      get: function () {
        return newCommon
      },
    })
    const signedTxn = txn.sign(pkey)
    st.ok(signedTxn.common.eips().includes(2537), 'signed tx common is taken from tx.common')
    st.end()
  })

  t.test('unsigned tx -> getMessageToSign()', function (t) {
    const unsignedTx = FeeMarketEIP1559Transaction.fromTxData(
      {
        data: Buffer.from('010200', 'hex'),
        to: validAddress,
        accessList: [[validAddress, [validSlot]]],
        chainId,
      },
      { common }
    )
    const expectedHash = Buffer.from(
      'fa81814f7dd57bad435657a05eabdba2815f41e3f15ddd6139027e7db56b0dea',
      'hex'
    )
    t.deepEqual(unsignedTx.getMessageToSign(true), expectedHash), 'correct hashed version'

    const expectedSerialization = Buffer.from(
      '02f85904808080809401010101010101010101010101010101010101018083010200f838f7940101010101010101010101010101010101010101e1a00101010101010101010101010101010101010101010101010101010101010101',
      'hex'
    )
    t.deepEqual(
      unsignedTx.getMessageToSign(false),
      expectedSerialization,
      'correct serialized unhashed version'
    )

    t.end()
  })

  t.test('toJSON()', function (st) {
    const data = testdata[0]
    const pkey = Buffer.from(data.privateKey.slice(2), 'hex')
    const txn = FeeMarketEIP1559Transaction.fromTxData(data, { common })
    const signed = txn.sign(pkey)

    const json = signed.toJSON()
    const expectedJSON = {
      chainId: '0x4',
      nonce: '0x333',
      maxPriorityFeePerGas: '0x1284d',
      maxFeePerGas: '0x1d97c',
      gasLimit: '0x8ae0',
      to: '0x000000000000000000000000000000000000aaaa',
      value: '0x2933bc9',
      data: '0x',
      accessList: [],
      v: '0x0',
      r: '0xf924cb68412c8f1cfd74d9b581c71eeaf94fff6abdde3e5b02ca6b2931dcf47',
      s: '0x7dd1c50027c3e31f8b565e25ce68a5072110f61fce5eee81b195dd51273c2f83',
    }
    st.deepEqual(json, expectedJSON, 'Should return expected JSON dict')
    st.end()
  })

  t.test('Fee validation', function (st) {
    st.doesNotThrow(() => {
      FeeMarketEIP1559Transaction.fromTxData(
        {
          maxFeePerGas: TWO_POW256.subn(1),
          maxPriorityFeePerGas: 100,
          gasLimit: 1,
          value: 6,
        },
        { common }
      )
    }, 'fee can be 2^256 - 1')
    st.throws(() => {
      FeeMarketEIP1559Transaction.fromTxData(
        {
          maxFeePerGas: TWO_POW256.subn(1),
          maxPriorityFeePerGas: 100,
          gasLimit: 100,
          value: 6,
        },
        { common }
      )
    }, 'fee must be less than 2^256')
    st.throws(() => {
      FeeMarketEIP1559Transaction.fromTxData(
        {
          maxFeePerGas: 1,
          maxPriorityFeePerGas: 2,
          gasLimit: 100,
          value: 6,
        },
        { common }
      )
    }, 'total fee must be the larger of the two')
    st.end()
  })
})
