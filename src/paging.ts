import { type FilterQuery, type Model, type SortOrder, Types } from 'mongoose';
import { first, isArray, last, pickBy } from 'lodash';
import { sign, verify } from 'jsonwebtoken';

export interface FindManyProps<T = any> {
  filter: FilterQuery<T>;
  paging: PagingInputInterface;
  sort?: {
    key: keyof T;
    KeyType: any;
    order: SortOrder;
  };
  search?: string;
}

type Sort<T> = { [K in keyof T]: SortOrder };

export class CursorInputInterface {
  after?: string;

  before?: string;
}

export interface PagingInputInterface {
  until?: Date;

  since?: Date;

  limit?: number;

  offset?: number;

  cursors?: CursorInputInterface;

  size?: number;

  search?: string;

  sortBy?: string;
}

export interface PagingProps<T> {
  filter: any;
  search?: string;
  key?: keyof T;
  KeyType?: any;
  order?: SortOrder;
  cursors?: {
    after?: any;
    before?: any;
  };
  toEntity?: any;
}

/* eslint-disable */
export class Paging<T> {
  static DEFAULT_KEY = '_id';
  static DEFAULT_TYPE = Types.ObjectId;
  static ASC: SortOrder = 1;
  static DESC: SortOrder = -1;

  filter: any;

  condition: any; // original filter

  originSort: Sort<T>;

  sort: Sort<T> & { _id?: SortOrder; score?: { $meta: 'textScore' } };

  key: keyof T;
  KeyType: any;
  order: SortOrder;

  reverse = false;

  secret: string;

  search: string;

  toEntity?: any;

  constructor(props: PagingProps<T>) {
    this.cursor = this.cursor.bind(this);
    this.build = this.build.bind(this);

    let {
      key = Paging.DEFAULT_KEY as keyof T,
      KeyType = Paging.DEFAULT_TYPE,
      order = Paging.ASC,
      cursors,
      filter = {},
      search,
      toEntity,
    } = props;

    this.toEntity = toEntity;
    this.search = search;
    this.key = key;
    this.KeyType = KeyType;
    this.order = order;
    this.condition = filter || {};
    this.filter = filter || {};
    this.secret = process.env.NEMOPA_SECRET || 'this-is-default';

    /**
     * 1. ĐIỀU KIỆN LẤY MẢNG TIẾP THEO.
     */
    if (cursors) {
      /**
       * Giải mã cursors, xác định chiều của mảng.
       */
      const { after, before } = this.decrypt(cursors);

      this.reverse = Boolean(before);

      /**
       * Lấy phần đăng sau cursor
       */

      if (after && before) {
        throw new Error('Cannot using both "after" and "before"');
      }

      this.filter[key] = after
        ? this.afterOf(after.cursor)
        : this.beforeOf(before.cursor);

      this.filter[key] ||= {};
      this.filter[key].$exists = true;
    }

    this.sort = (
      this.reverse
        ? {
            [key]: order === Paging.ASC ? Paging.DESC : Paging.ASC,
          }
        : { [key]: order }
    ) as Sort<T>;

    if (this.search) {
      this.filter.$text = { $search: this.search };
      this.sort.score = { $meta: 'textScore' };
    }

    this.filter = pickBy(this.filter, (value) =>
      isArray(value)
        ? value.length > 0
        : value !== undefined && value !== null && value !== '',
    ) as { [P in keyof T]?: any };
  }

  /**
   * Trả về điều kiện để đi tiếp từ cursors
   */
  afterOf(cursor: any) {
    const KeyType = this.KeyType;
    return this.order === Paging.ASC
      ? { $gt: KeyType ? new KeyType(cursor) : cursor }
      : { $lt: KeyType ? new KeyType(cursor) : cursor };
  }

  /**
   * Trả về điều kiện để đi ngược cursors
   * Mảng thuận từ bé đến lớn thì lấy đằng trước, những cái có giá trị nhỏ hơn.
   * Mảng nghịch thì lấy ngược lại.
   */
  beforeOf(cursor: any) {
    const KeyType = this.KeyType;

    return this.order === Paging.ASC
      ? { $lt: KeyType ? new KeyType(cursor) : cursor }
      : { $gt: KeyType ? new KeyType(cursor) : cursor };
  }

  decrypt(cursors: { after?: string; before?: string }) {
    return {
      after: cursors?.after && this.parse(cursors.after),
      before: cursors?.before && this.parse(cursors.before),
    };
  }

  /**
   * DECODE
   * decode, encrypt, parse... from string
   */
  parse(cursor: string) {
    try {
      if (this.secret) {
        return verify(cursor, this.secret);
      } else {
        return JSON.parse(cursor);
      }
    } catch (e) {
      throw new Error(`Pagination error.`);
    }
  }

  stringify(cursor: any) {
    const value = { cursor };
    if (this.secret) {
      return sign(value, this.secret);
    } else {
      return JSON.stringify(value);
    }
  }

  /**
   * Trả về mảng kết quả
   * cursors để lấy trạng thái tiếp theo
   */
  cursor(many: Array<T & { _id?: any }>) {
    /**
     * Chuẩn hoá chiều kết quả
     * cho trường hợp mảng từ bé đến lớn, tại vị trí cursos lấy ngược các phần tử bé hơn.
     */
    const data = this.reverse ? many.reverse() : many;

    /* vị trí chốt */
    const lastCursor = last(data)?.[this.key];
    /* gộp điều kiện hiện tại */
    let filterNext = Object.assign({}, this.filter);
    /* điều kiện kết quả tiếp theo */
    filterNext[this.key] = this.afterOf(lastCursor);

    /* vị trí chốt */
    const firstCursor = first(data)?.[this.key];
    /* gộp điều kiện hiện tại */
    let filterPrevious = Object.assign({}, this.filter);
    /* điều kiện kết quả trước */
    filterPrevious[this.key] = this.beforeOf(firstCursor);

    return {
      afterCursor: this.stringify(lastCursor),
      beforeCursor: this.stringify(firstCursor),
      filterNext,
      filterPrevious,
      data,
    };
  }

  async build(many: Array<T>, model: Model<T>) {
    const { afterCursor, beforeCursor, filterNext, filterPrevious, data } =
      this.cursor(many);
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

export class PagingWithPage<T> {
  limit?: number;
  offset?: number;
  skip?: number;
  size?: number;
  filter?: any;
  constructor(props: { filter: any; paging: PagingInputInterface }) {
    this.size = Number(props?.paging?.size) || 10;
    this.limit = Number(props?.paging?.limit) || this.size;
    this.skip = Number(props?.paging?.offset) || 0;
    this.filter = props?.filter || {};
    this.build = this.build.bind(this);
  }

  async build(many: Array<T>, model: Model<T>) {
    const margin = 3;
    const count = await model.countDocuments(this.filter);
    const length = Math.ceil(count / this.size);
    const current = Math.ceil(this.skip / this.size) + 1;

    /**
     * page number
     */

    const pages = Array.from({ length }, (_v, i) => {
      return {
        more: false,
        current: i + 1 === current,
        index: i + 1,
        limit: this.size,
        offset: i * this.size,
      };
    });

    let from = current - margin;
    let to = current + margin;

    /**
     * left margin modify
     */
    if (from < 0) {
      to = to - from;
      from = 0;
    }

    /**
     * right margin modify
     */
    if (to > length) {
      from = from - (to - length);
      to = length;
    }
    const pagination = pages.slice(from, to);

    /**
     * last pagination node
     */
    if (!pagination.find((page) => page.index === length)) {
      pagination.push({
        more: true,
        current: length === current,
        index: length,
        limit: this.size,
        offset: (length - 1) * this.size,
      });
    }

    /**
     * fist pagination node
     */
    if (!pagination.find((page) => page.index === 1)) {
      pagination.unshift({
        more: true,
        current: 1 === current,
        index: 1,
        limit: this.size,
        offset: 0,
      });
    }

    return {
      count,
      from: this.skip,
      to: this.skip + many.length,
      pages: pagination,
    };
  }
}
