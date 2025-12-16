import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';
import { esAuthenticate, esGetPrivateSearchByTable } from '../libs/es';

export default {
	v1PrivateSearchByTable: async (
		c: OpenAPIContext,
		ctx: Koa.Context
	): Promise<void> => {
		try {
			const user = await esAuthenticate(ctx.headers.authorization);
			if (user === false) {
				ctx.body = {
					errors: [{ message: 'Username or password is not recognized.' }],
				};
				ctx.status = 401;
				return;
			}
			const { repository: repositories, table: tables } = c.request.params;
			const { n_max_rows, from, query } = c.request.query;
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
			ctx.body = await esGetPrivateSearchByTable({
				repository,
				contributor: `@${user.handle}`,
				table: table === 'contributions' ? 'contribution' : table,
				size: n_max_rows !== undefined ? size : 10,
				from: from !== undefined ? fromNumber : undefined,
				queries: query !== undefined ? queries : undefined,
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
