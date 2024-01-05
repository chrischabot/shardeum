import { nestedCountersInstance } from '@shardus/core'
import { Migration } from '../types'
import { shardusConfig } from '../..'

export const migrate: Migration = async () => {
  console.log('migrate 1.9.1')
  nestedCountersInstance.countEvent('migrate-1.9.1', 'calling migrate 1.9.1')

  // Enable networkBaseline
  shardusConfig.p2p.networkBaselineEnabled = true
}