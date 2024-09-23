# Description

If you using NestJS with: Pagination, GraphQL code-first, Mongoose. This package
is fit for you.

# Install

with npm

```
npm i nest-mopa
```

with yarn

```
yarn add nest-mopa
```

# Using

## Latest version

```ts
import { DEFAULT_KEY, PagingV3 } from 'nest-mopa';
import type { FindManyProps } from 'nest-gfc';
import type { HydratedDocument } from 'mongoose';

/**
 * @nestjs/mongoose
 */
export class MongoSchema {}
export type MongoDocument = HydratedDocument<MongoSchema>;

async function findMany(props: FindManyProps<MongoDocument>) {
  const { filter, sort, build, skip, limit } = new PagingV3<MongoDocument>({
    filter: props.filter,
    primary: props.sort,
    secondary: DEFAULT_KEY,
    search: props.search,
    paging: props.paging,
  });
  let many = await this.model
    .find(filter)
    .sort(sort as any)
    .limit(limit)
    .skip(skip);
  let data = await build(many, this.model);
  return data;
}
```

## Other version

```ts
import { Paging, PagingInputInterface, PagingWithPage } from 'nest-mopa';

/**
 * filter is a MongoDB Filter<T>
 */
interface FindManyProps {
  filter: any;
  paging: PagingInputInterface;
}

/**
 * In case I choose updatedAt_utc as a Cursor
 */
interface TodoDocument {
  updatedAt_utc: Date;
}

class TodoCRUD {
  private model: Model<TodoDocument>;
  async findMany(props: FindManyProps) {
    const { filter, sort, build } = new Paging<TodoDocument>({
      cursors: props?.paging?.cursors,
      filter: props.filter,
      order: Paging.DESC,
      key: 'updatedAt_utc',
      KeyType: Date,
    });
    const limit = Number(props?.paging?.limit || 10);
    if (limit > 20) throw new Error('rate limit');

    const skip = Number(props?.paging?.offset);
    const many = await this.model
      .find(filter)
      .sort(sort)
      .limit(limit)
      .skip(skip);
    return build(many, this.model);
  }
}
```
