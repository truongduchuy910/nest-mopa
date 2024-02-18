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

```ts
import { Paging, PagingInputInterface, PagingWithPage } from "nest-mopa";

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
      key: "updatedAt_utc",
      KeyType: Date,
    });
    const limit = Number(props?.paging?.limit || 10);
    if (limit > 20) throw new Error("rate limit");

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
