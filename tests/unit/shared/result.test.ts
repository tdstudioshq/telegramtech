import { describe, expect, it } from 'vitest';
import { appError, isAppError } from '../../../src/shared/app-error.js';
import {
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unwrapOr,
} from '../../../src/shared/result.js';

describe('Result', () => {
  it('ok/err construct discriminated values', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(err('nope'))).toBe(true);
    expect(isOk(err('nope'))).toBe(false);
  });

  it('map transforms only ok values', () => {
    expect(map(ok(2), (n) => n * 2)).toEqual(ok(4));
    expect(map(err('e'), (n: number) => n * 2)).toEqual(err('e'));
  });

  it('mapErr transforms only errors', () => {
    expect(mapErr(err('e'), (e) => `${e}!`)).toEqual(err('e!'));
    expect(mapErr(ok(1), (e: string) => `${e}!`)).toEqual(ok(1));
  });

  it('andThen chains and short-circuits on err', () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err('odd'));
    expect(andThen(ok(4), half)).toEqual(ok(2));
    expect(andThen(ok(3), half)).toEqual(err('odd'));
    expect(andThen(err('early'), half)).toEqual(err('early'));
  });

  it('unwrapOr falls back only on err', () => {
    expect(unwrapOr(ok(1), 9)).toBe(1);
    expect(unwrapOr(err('e'), 9)).toBe(9);
  });
});

describe('AppError', () => {
  it('builds a code + user-safe message value', () => {
    const error = appError('not_found', 'That drop does not exist.', { dropId: 'd-1' });
    expect(error.code).toBe('not_found');
    expect(error.context).toEqual({ dropId: 'd-1' });
    expect(isAppError(error)).toBe(true);
  });

  it('omits context when not provided', () => {
    expect(appError('internal', 'Something went wrong.')).toEqual({
      code: 'internal',
      message: 'Something went wrong.',
    });
  });

  it('isAppError rejects non-error values', () => {
    expect(isAppError(null)).toBe(false);
    expect(isAppError('oops')).toBe(false);
    expect(isAppError({ code: 'x' })).toBe(false);
  });
});
