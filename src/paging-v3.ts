import { type Model, type SortOrder, Types } from 'mongoose';
import {
  clone,
  first,
  isArray,
  isEmpty,
  last,
  merge,
  pick,
  pickBy,
} from 'lodash';
import { sign, verify } from 'jsonwebtoken';
import type { Key, PagingPropsV3, Sort } from 'nest-gfc';

export const ASC: SortOrder = 1;
export const DESC: SortOrder = -1;

export const DEFAULT_KEY = {
  key: '_id',
  keyBuilder: (one: any) =>
    typeof one == 'string' ? new Types.ObjectId(one) : one,
  keyOrder: ASC,
} as Key<any>;

class KeyBuilder<T> implements Key<T> {
  key?: keyof T;
  keyBuilder?: any;
  keyOrder?: any;

  constructor(props: Key<T>) {
    Object.assign(this, props);
  }

  /**
   * Trả về điều kiện để đi tiếp từ cursors
   */
  afterOf(cursor: any) {
    try {
      const builder = this.keyBuilder;
      return this.keyOrder === ASC
        ? { $gt: builder ? builder(cursor) : cursor, $exists: true }
        : { $lt: builder ? builder(cursor) : cursor, $exists: true };
    } catch {
      return null;
    }
  }

  /**
   * Trả về điều kiện để đi ngược cursors
   * Mảng thuận từ bé đến lớn thì lấy đằng trước, những cái có giá trị nhỏ hơn.
   * Mảng nghịch thì lấy ngược lại.
   */
  beforeOf(cursor: any) {
    try {
      const builder = this.keyBuilder;
      return this.keyOrder === ASC
        ? { $lt: builder ? builder(cursor) : cursor, $exists: true }
        : { $gt: builder ? builder(cursor) : cursor, $exists: true };
    } catch {
      return null;
    }
  }
}

class CursorBuilder<T> {
  private primary?: KeyBuilder<T>;
  private secondary?: KeyBuilder<T>;
  private keys?: Array<any>;

  constructor(primary: Key<T>, secondary: Key<T>) {
    this.node = this.node.bind(this);
    if (isEmpty(primary) && secondary) {
      primary = secondary;
      secondary = null;
    }
    this.primary = new KeyBuilder<T>(primary || (DEFAULT_KEY as any));
    this.keys = [this.primary.key];
    if (secondary) {
      this.secondary = secondary && new KeyBuilder<T>(secondary);
      this.keys.push(this.secondary.key);
    }
  }

  afterOf(node: T) {
    const pivot = this.pivot(node);
    const primary = this.primary.key;
    const secondary = this?.secondary?.key;
    const value = pivot?.[primary];
    const next = {
      [primary]: this.primary.afterOf(value),
    };
    if (secondary)
      return {
        $or: [
          next,
          {
            [primary]: { $eq: value },
            [secondary]: this.secondary.afterOf(pivot?.[secondary]),
          },
        ],
      };

    return next;
  }

  beforeOf(node: T) {
    const pivot = this.pivot(node);
    const primary = this.primary.key;
    const secondary = this?.secondary?.key;
    const value = pivot?.[primary];
    const next = {
      [primary]: this.primary.beforeOf(value),
    };
    if (secondary)
      return {
        $or: [
          next,
          {
            [primary]: { $eq: value },
            [secondary]: this.secondary.beforeOf(pivot?.[secondary]),
          },
        ],
      };

    return next;
  }

  order(keyOrder: Sort<T>, reverse: boolean) {
    if (reverse) return keyOrder === ASC ? DESC : ASC;

    return keyOrder;
  }

  sort(reverse?: boolean) {
    const primary = this.primary.key;
    const secondary = this?.secondary?.key;
    if (secondary)
      return {
        [primary]: this.order(this.primary.keyOrder, reverse),
        [secondary]: this.order(this.secondary.keyOrder, reverse),
      } as Sort<T>;

    return {
      [primary]: this.order(this.primary.keyOrder, reverse),
    } as Sort<T>;
  }

  /**
   * Trả về dữ liệu để làm chốt chặn
   */
  pivot(node: T): Partial<T> {
    return pick(node, this.keys);
  }

  /**
   * Trả về chốt chặn dạng plain text
   */
  plain(node: T) {
    const primary = this.primary.key;
    const secondary = this?.secondary?.key;
    const value =
      node?.[primary] instanceof Date
        ? (node[primary] as any).toISOString()
        : `${node?.[primary]}`;
    if (secondary)
      return {
        [primary]: value,
        [secondary]: `${node?.[secondary]}`,
      } as Partial<T>;

    return {
      [primary]: value,
    } as Partial<T>;
  }

  node(data: any) {
    const primary = this.primary.key;
    const secondary = this?.secondary?.key;
    if (secondary)
      return {
        [primary]: this.primary.keyBuilder(data?.[primary]),
        [secondary]: this.secondary.keyBuilder(data?.[secondary]),
      } as Partial<T>;

    return {
      [primary]: this.primary.keyBuilder(data?.[primary]),
    } as Partial<T>;
  }
}

/* eslint-disable */
export class PagingV3<T> {
  /**
   * filter cuối cùng trả về để try vấn
   * là dạng sau khi xử lý cursor
   */
  filter: any;

  /**
   * filter gốc người dùng truyền vào
   */
  condition: any; // original filter

  /**
   * Điều kiện sắp xếp sau khi xử lý cursor
   */
  sort: Sort<T> & { _id?: SortOrder; score?: { $meta: 'textScore' } };

  limit: number;
  skip: number;

  private builder: CursorBuilder<T>;

  /**
   * when get previous result
   */
  private reverse = false;
  private secret: string;
  private search: string;
  private toEntity?: any;

  constructor(props: PagingPropsV3<T>) {
    this.encryptAll = this.encryptAll.bind(this);
    this.build = this.build.bind(this);
    this.builder = new CursorBuilder(props.primary, props.secondary);
    this.search = props.search;
    this.condition = clone(props.filter) || {};
    this.filter = clone(props.filter) || {};
    this.secret = process.env.NEMOPA_SECRET || 'this-is-default';
    this.toEntity = props.toEntity;
    this.limit = props.paging?.limit || 0;
    this.skip = props.paging?.offset || 0;
    const cursors = props.paging?.cursors;

    /**
     * 1. ĐIỀU KIỆN LẤY MẢNG TIẾP THEO.
     */
    if (cursors) {
      /**
       * Giải mã cursors, xác định chiều của mảng.
       */
      const { after, before } = this.decryptAll(cursors);
      if (after && before) {
        throw new Error('Cannot using both "after" and "before"');
      }

      this.reverse = Boolean(before);
      const node = this.builder.node(before || after) as T;
      const cursor = this.reverse
        ? this.builder.beforeOf(node)
        : this.builder.afterOf(node);
      this.filter = merge(this.filter, cursor);
    }

    this.sort = this.builder.sort(this.reverse);

    if (this.search) {
      this.filter.$text = { $search: this.search };
      this.sort.score = { $meta: 'textScore' };
    }

    this.filter = pickBy(this.filter) as { [P in keyof T]?: any };
  }

  decryptAll(cursors: { after?: string; before?: string }) {
    return {
      after: cursors?.after && this.decrypt(cursors.after),
      before: cursors?.before && this.decrypt(cursors.before),
    };
  }

  /**
   * DECODE
   * decode, encrypt, parse... from string
   */
  decrypt(cursor: string): Partial<T> | null {
    try {
      if (this.secret) {
        return verify(cursor, this.secret) as any;
      } else {
        return JSON.parse(cursor);
      }
    } catch {
      return null;
    }
  }

  encrypt(cursor: T): string | null {
    try {
      const value = this.builder.plain(cursor);
      if (this.secret) {
        return sign(value, this.secret);
      } else {
        return JSON.stringify(value);
      }
    } catch {
      return null;
    }
  }

  /**
   * Trả về mảng kết quả
   * cursors để lấy trạng thái tiếp theo
   */
  encryptAll(many: Array<T & { _id?: any }>) {
    if (!many?.length) return { data: many };
    /**
     * Chuẩn hoá chiều kết quả
     * cho trường hợp mảng từ bé đến lớn, tại vị trí cursos lấy ngược các phần tử bé hơn.
     */
    const data = this.reverse ? many.reverse() : many;
    //const keys = [this.key, this.DEFAULT_KEY];

    /* vị trí chốt */
    //const lastCursor = pick(last(data), keys);
    const lastPivot = last(data);

    /**
     * gộp điều kiện hiện tại
     * điều kiện kết quả tiếp theo */
    let filterNext = { $and: [this.builder.afterOf(lastPivot), this.filter] };

    /* vị trí chốt */
    //const firstCursor = pick(first(data), keys);
    const firstPivot = first(data);
    /**
     * gộp điều kiện hiện tại
     * điều kiện kết quả trước */
    let filterPrevious = {
      $and: [this.builder.beforeOf(firstPivot), this.filter],
    };

    return {
      afterCursor: this.encrypt(lastPivot),
      beforeCursor: this.encrypt(firstPivot),
      filterNext,
      filterPrevious,
      data,
    };
  }

  async build(many: Array<T> = [], model: Model<T>) {
    const { afterCursor, beforeCursor, filterNext, filterPrevious, data } =
      this.encryptAll(many);
    const countPrevious = (await model.countDocuments(filterPrevious)) || 0;
    const countNext = (await model.countDocuments(filterNext)) || 0;
    const count = await model.countDocuments(this.condition);

    const entities =
      typeof this.toEntity == 'function'
        ? data.map((one) => this.toEntity(one))
        : data;

    return {
      data: entities,
      paging: {
        count,
        length: data.length,
        next: countNext ? { after: `${afterCursor}`, count: countNext } : null,
        previous: countPrevious
          ? { before: `${beforeCursor}`, count: countPrevious }
          : null,
      },
    };
  }
}
