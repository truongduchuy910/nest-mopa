import { type FilterQuery, type Model, type SortOrder, Types } from 'mongoose';
import { first, isArray, last, pickBy, get } from 'lodash';
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

  key?: keyof T;
  keyBuilder?: any;
  keyOrder?: any;

  order?: SortOrder;
  search?: string;
  cursors?: {
    after?: any;
    before?: any;
  };
  toEntity?: any;
}

/* eslint-disable */
export class Paging<T> {
  static DEFAULT_KEY = '_id';
  static DEFAULT_KEY_BUILDER = (id: any) => new Types.ObjectId(id);
  static DEFAULT_KEY_SORT: SortOrder = 1;

  static ASC: SortOrder = 1;
  static DESC: SortOrder = -1;

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

  key: keyof T;
  keyBuilder?: any;
  keyOrder: SortOrder;

  reverse = false;

  secret: string;

  search: string;

  toEntity?: any;

  constructor(props: PagingProps<T>) {
    this.cursor = this.cursor.bind(this);
    this.build = this.build.bind(this);

    let {
      key = Paging.DEFAULT_KEY as keyof T,
      keyBuilder = Paging.DEFAULT_KEY_BUILDER,
      keyOrder = Paging.DEFAULT_KEY_SORT,
      cursors,
      filter = {},
      search,
      toEntity,
    } = props;

    this.keyBuilder = keyBuilder;
    this.keyOrder = keyOrder;
    this.key = key;

    this.search = search;
    this.condition = filter || {};
    this.filter = filter || {};
    this.secret = process.env.NEMOPA_SECRET || 'this-is-default';
    this.toEntity = toEntity;

    /**
     * 1. ĐIỀU KIỆN LẤY MẢNG TIẾP THEO.
     */
    const actualOrder = this.reverse
      ? keyOrder === Paging.ASC
        ? Paging.DESC
        : Paging.ASC
      : keyOrder;

    this.sort = { [key]: actualOrder, _id: actualOrder } as Sort<T>;

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
        throw new Error('Cannot use both "after" and "before" cursors.');
      }

      this.filter = after
        ? { ...this.filter, ...this.afterCursorCondition(after.value, after._id) }
        : { ...this.filter, ...this.beforeCursorCondition(before.value, before._id) };

    } else {
      this.filter[key] ||= {};
      this.filter[key].$exists = true;

      this.filter[Paging.DEFAULT_KEY] ||= {};
      this.filter[Paging.DEFAULT_KEY].$exists = true;
    }

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
  private afterOf(key: any, value: any, builder?: any) {
    const operator = this.keyOrder === Paging.ASC ? '$gt' : '$lt';
    return { [key]: { [operator]: builder ? builder(value) : value, $exists: true } };
  }

  /**
   * Trả về điều kiện để đi ngược cursors
   * Mảng thuận từ bé đến lớn thì lấy đằng trước, những cái có giá trị nhỏ hơn.
   * Mảng nghịch thì lấy ngược lại.
   */
  private beforeOf(key: any, value: any, builder?: any) {
    const operator = this.keyOrder === Paging.ASC ? '$lt' : '$gt';
    return { [key]: { [operator]: builder ? builder(value) : value, $exists: true } };
  }

  private afterCursorCondition(lastCursorValue: any, lastCursorId: any) {
    if (this.key === Paging.DEFAULT_KEY) {
      return this.afterOf(Paging.DEFAULT_KEY, lastCursorId, Paging.DEFAULT_KEY_BUILDER);
    }

    return {
      $or: [
        {
          [this.key]: { $eq: this.keyBuilder ? this.keyBuilder(lastCursorValue) : lastCursorValue, $exists: true },
          ...this.afterOf(Paging.DEFAULT_KEY, lastCursorId, Paging.DEFAULT_KEY_BUILDER)
        },
        this.afterOf(this.key, lastCursorValue, this.keyBuilder)
      ]
    };
  }

  private beforeCursorCondition(firstCursorValue: any, firstCursorId: any) {
    if (this.key === Paging.DEFAULT_KEY) {
      return this.beforeOf(Paging.DEFAULT_KEY, firstCursorId, Paging.DEFAULT_KEY_BUILDER);
    }

    return {
      $or: [
        {
          [this.key]: { $eq: this.keyBuilder ? this.keyBuilder(firstCursorValue) : firstCursorValue, $exists: true },
          ...this.beforeOf(Paging.DEFAULT_KEY, firstCursorId, Paging.DEFAULT_KEY_BUILDER)
        },
        this.beforeOf(this.key, firstCursorValue, this.keyBuilder)
      ]
    };
  }

  private decrypt(cursors: { after?: string; before?: string }) {
    return {
      after: cursors?.after && this.parse(cursors.after),
      before: cursors?.before && this.parse(cursors.before),
    };
  }

  /**
   * DECODE
   * decode, encrypt, parse... from string
   */
  private parse(cursor: string) {
    try {
      if (this.secret) {
        return verify(cursor, this.secret);
      } else {
        return JSON.parse(cursor);
      }
    } catch (e) {
      throw new Error('Pagination error.');
    }
  }

  private stringify(key: any, value: any, _id: string) {
    const cursor = { 
      key, 
      value, 
      _id 
    };
    return this.secret ? sign(cursor, this.secret) : JSON.stringify(cursor);
  }

  /**
   * Trả về mảng kết quả
   * cursors để lấy trạng thái tiếp theo
   */
  cursor(many: Array<T & { _id?: any }>) {
    if (!many?.length) return { data: many };
    /**
     * Chuẩn hoá chiều kết quả
     * cho trường hợp mảng từ bé đến lớn, tại vị trí cursos lấy ngược các phần tử bé hơn.
     */
    const data = this.reverse ? many.reverse() : many;

    /* vị trí chốt */
    const lastCursor = this.createCursor(last(data));
    /* điều kiện kết quả tiếp theo */
    const filterNext = { ...this.filter, ...this.afterCursorCondition(lastCursor.value, lastCursor._id) };

    /* vị trí chốt */
    const firstCursor = this.createCursor(first(data));
    /* điều kiện kết quả trước */
    const filterPrevious = { ...this.filter, ...this.beforeCursorCondition(firstCursor.value, firstCursor._id) };

    return {
      afterCursor: this.stringify(this.key, lastCursor.value, lastCursor._id),
      beforeCursor: this.stringify(this.key, firstCursor.value, firstCursor._id),
      filterNext,
      filterPrevious,
      data,
    };
  }

  private createCursor(cursorItem: T & { _id?: any }) {
    return {
      value: get(cursorItem, this.key, null),
      _id: cursorItem?._id,
    };
  }

  async build(many: Array<T>, model: Model<T>) {
    const { afterCursor, beforeCursor, filterNext, filterPrevious, data } = this.cursor(many);
    const [countPrevious, countNext, count] = await Promise.all([
      model.countDocuments(filterPrevious) || 0,
      model.countDocuments(filterNext) || 0,
      model.countDocuments(this.condition),
    ]);

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
