import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';
import { esCheckConnection, esAuthenticate } from '../libs/es';

export default {
	v1HealthCheck: async (c: OpenAPIContext, ctx: Koa.Context): Promise<void> => {
		try {
			const healthy: boolean = await esCheckConnection();
			if (healthy) {
				ctx.status = 200;
				ctx.body = {
					message: 'Healthy!',
				};
			} else {
				ctx.status = 500;
				ctx.body = {
					errors: [{ message: 'Health has check failed.' }],
				};
			}
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
	v1Authenticate: async (
		c: OpenAPIContext,
		ctx: Koa.Context
	): Promise<void> => {
		try {
			ctx.body = await esAuthenticate(ctx.headers.authorization);
			if (ctx.body === false) {
				ctx.status = 401;
				ctx.body = {
					errors: [{ message: 'Username or password is not recognized.' }],
				};
			}
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
};
