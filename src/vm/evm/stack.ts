import { BN, MAX_INTEGER } from 'ethereumjs-util'
import { ERROR, VmError } from '../exceptions'

/**
 * Implementation of the stack used in evm.
 */
export default class Stack {
  _store: BN[]
  _maxHeight: number

  constructor(maxHeight?: number) {
    this._store = []
    this._maxHeight = maxHeight ?? 1024
  }

  get length(): number {
    return this._store.length
  }

  push(value: BN): void {
    if (!BN.isBN(value)) {
      throw new VmError(ERROR.INTERNAL_ERROR)
    }

    if (value.gt(MAX_INTEGER)) {
      throw new VmError(ERROR.OUT_OF_RANGE)
    }

    if (this._store.length >= this._maxHeight) {
      throw new VmError(ERROR.STACK_OVERFLOW)
    }

    this._store.push(value)
  }

  pop(): BN {
    if (this._store.length < 1) {
      throw new VmError(ERROR.STACK_UNDERFLOW)
    }

    // Length is checked above, so pop shouldn't return undefined
    return this._store.pop()!
  }

  /**
   * Pop multiple items from stack. Top of stack is first item
   * in returned array.
   * @param num - Number of items to pop
   */
  popN(num = 1): BN[] {
    if (this._store.length < num) {
      throw new VmError(ERROR.STACK_UNDERFLOW)
    }

    if (num === 0) {
      return []
    }

    return this._store.splice(-1 * num).reverse()
  }

  /**
   * Return items from the stack
   * @param num Number of items to return
   * @throws {@link ERROR.STACK_UNDERFLOW}
   */
  peek(num = 1): BN[] {
    const peekArray: BN[] = []

    for (let peek = 1; peek <= num; peek++) {
      const index = this._store.length - peek
      if (index < 0) {
        throw new VmError(ERROR.STACK_UNDERFLOW)
      }
      // eslint-disable-next-line security/detect-object-injection
      peekArray.push(this._store[index])
    }
    return peekArray
  }

  /**
   * Swap top of stack with an item in the stack.
   * @param position - Index of item from top of the stack (0-indexed)
   */
  swap(position: number): void {
    if (this._store.length <= position) {
      throw new VmError(ERROR.STACK_UNDERFLOW)
    }

    const head = this._store.length - 1
    const i = this._store.length - position - 1

    /* eslint-disable security/detect-object-injection */
    const tmp = this._store[head]
    this._store[head] = this._store[i]
    this._store[i] = tmp
    /* eslint-enable security/detect-object-injection */
  }

  /**
   * Pushes a copy of an item in the stack.
   * @param position - Index of item to be copied (1-indexed)
   */
  dup(position: number): void {
    if (this._store.length < position) {
      throw new VmError(ERROR.STACK_UNDERFLOW)
    }

    const i = this._store.length - position
    // eslint-disable-next-line security/detect-object-injection
    this.push(this._store[i].clone())
  }
}
