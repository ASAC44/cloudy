export type * from './types/store.js'

export class StoreError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
  }
}
