import {
  AccessListEIP2930Transaction,
  Transaction,
  TransactionFactory,
  TransactionType,
} from '@ethereumjs/tx'
import * as crypto from '@shardus/crypto-utils'
import { toBuffer } from 'ethereumjs-util'
import { ShardeumFlags } from '../shardeum/shardeumFlags'
import { InternalTx, InternalTXType } from '../shardeum/shardeumTypes'
import { stringify, cryptoStringify } from '../utils/stringify'

// console.log(crypto.)

crypto.init('69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc')
crypto.setCustomStringifier(cryptoStringify, 'shardeum_crypto_stringify')
export { crypto }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function verify(obj: any, expectedPk?: string): boolean {
  if (expectedPk) {
    if (obj.sign.owner !== expectedPk) return false
  }
  return crypto.verifyObj(obj)
}

export function isInternalTXGlobal(internalTx: InternalTx): boolean {
  return (
    internalTx.internalTXType === InternalTXType.SetGlobalCodeBytes ||
    internalTx.internalTXType === InternalTXType.ApplyChangeConfig ||
    internalTx.internalTXType === InternalTXType.InitNetwork ||
    internalTx.internalTXType === InternalTXType.ApplyNetworkParam
  )
}

export function isInternalTx<T extends { isInternalTx?: unknown }>(tx: T): boolean {
  console.log("daoLogging: isInternalTx", !!tx.isInternalTx)
  return !!tx.isInternalTx
}

export function isDebugTx<T extends { isDebugTx?: unknown }>(tx: T): boolean {
  return !!tx.isDebugTx
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTransactionObj(
  tx
): Transaction[TransactionType.Legacy] | Transaction[TransactionType.AccessListEIP2930] {
  if (!tx.raw) throw Error('fail')
  let transactionObj
  const serializedInput = toBuffer(tx.raw)
  try {
    transactionObj = TransactionFactory.fromSerializedData<TransactionType.Legacy>(serializedInput)
  } catch (e) {
    // if (ShardeumFlags.VerboseLogs) console.log('Unable to get legacy transaction obj', e)
  }
  if (!transactionObj) {
    try {
      transactionObj =
        TransactionFactory.fromSerializedData<TransactionType.AccessListEIP2930>(serializedInput)
    } catch (e) {
      if (ShardeumFlags.VerboseLogs) console.log('Unable to get transaction obj', e)
    }
  }

  if (transactionObj) {
    Object.freeze(transactionObj)
    return transactionObj
  } else throw Error('tx obj fail')
}

export function getInjectedOrGeneratedTimestamp(timestampedTx): number {
  const { tx, timestampReceipt } = timestampedTx
  let txnTimestamp: number

  if (timestampReceipt && timestampReceipt.timestamp) {
    txnTimestamp = timestampReceipt.timestamp
    if (ShardeumFlags.VerboseLogs) {
      console.log(`Timestamp ${txnTimestamp} is generated by the network nodes.`)
    }
  } else if (tx.timestamp) {
    txnTimestamp = tx.timestamp
    if (ShardeumFlags.VerboseLogs) {
      console.log(`Timestamp ${txnTimestamp} is extracted from the injected tx.`)
    }
  }
  return txnTimestamp
}

/**
 * This will request the sign field to be removed if one is present
 * All transactions should be hashed this way to avoid consistency issues
 * @param obj
 * @returns
 */
export function hashSignedObj(obj): string {
  if (ShardeumFlags.txHashingFix === false) {
    //if the feature is not on ignore the smart logic below and just hash the object
    return crypto.hashObj(obj)
  }

  if (!obj.sign) {
    return crypto.hashObj(obj)
  }
  return crypto.hashObj(obj, true)
}
