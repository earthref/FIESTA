/* eslint-disable camelcase */
import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';
import { esGetSearchByTable } from '../libs/es';

export default {
	v1PublicSearchByTable: async (
		c: OpenAPIContext,
		ctx: Koa.Context
	): Promise<void> => {
		try {
			const { repository: repositories, table: tables } = c.request.params;
			const { n_max_rows, from, query, included_columns, missing_columns } = c.request.query;
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			const table: string = tables instanceof Array ? tables[0] : tables;
			const size: number = parseInt(
				n_max_rows instanceof Array ? n_max_rows[0] : n_max_rows,
				10
			);
			const fromNumber: number = parseInt(
				from instanceof Array ? from[0] : from,
				10
			);
			const queries: string[] = query instanceof Array ? query : [query];
			const exists_fields: string[] = included_columns instanceof Array ? included_columns : [included_columns];
			const not_exists_fields: string[] = missing_columns instanceof Array ? missing_columns : [missing_columns];
			const tableMap = {
				contributions: 'contribution',
				measurements: 'experiments',
			};
			ctx.body = await esGetSearchByTable({
				repository,
				table: tableMap[table] || table,
				size: n_max_rows !== undefined ? size : 10,
				from: from !== undefined ? fromNumber : undefined,
				queries: query !== undefined ? queries : undefined,
				exists_fields: included_columns !== undefined ? exists_fields.map(x => `summary._all.${x}`) : undefined,
				not_exists_fields: missing_columns !== undefined ? not_exists_fields.map(x => `summary._all.${x}`) : undefined,
			});
			if (ctx.body === undefined) {
				ctx.status = 204;
			}
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
};
