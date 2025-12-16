/* eslint-disable camelcase */
import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';
import { esAuthenticate, esValidatePrivateContribution } from '../libs/es';

export default {
	v1PrivateContributionValidate: async (
		c: OpenAPIContext,
		ctx: Koa.Context
	): Promise<void> => {
		try {
			const user = await esAuthenticate(ctx.headers.authorization);
			if (user === false) {
				ctx.body = {
					errors: [{ message: 'Username or password is not recognized' }],
				};
				ctx.status = 401;
				return;
			}
			const { repository: repositories } = c.request.params;
			const { id: ids } = c.request.query;
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			const id: number = parseInt(ids instanceof Array ? ids[0] : ids);
			if (id === undefined) {
				ctx.status = 502;
				ctx.body = {
					errors: [
						{
							message:
								'A contribution ID is required when validating a private contribution.',
						},
					],
				};
				return;
			}
			const validation = await esValidatePrivateContribution({
				repository,
				contributor: `@${user.handle}`,
				id,
			});
			if (validation === undefined) {
				ctx.status = 204;
				return;
			}
			ctx.status = 200;
			ctx.body = { validation };
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
};
