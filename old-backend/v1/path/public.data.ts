/* eslint-disable camelcase */
import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';
import { esGetContributionData } from '../libs/es';
import { s3GetContributionByID } from '../libs/s3';

export default {
	v1PublicContributionData: async (
		c: OpenAPIContext,
		ctx: Koa.Context
	): Promise<void> => {
		try {
			const { repository: repositories } = c.request.params;
			const { id: ids, key: keys } = c.request.query;
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			const id: string = ids instanceof Array ? ids[0] : ids;
			const key: string = keys instanceof Array ? keys[0] : keys;
			if (id === undefined && key !== undefined) {
				ctx.status = 502;
				ctx.body = {
					errors: [
						{
							message:
								'A contribution ID is required when requesting data from a shared contribution with a private key.',
						},
					],
				};
				return;
			}
			if (id === undefined) {
				ctx.status = 502;
				ctx.body = {
					errors: [
						{
							message:
								'A contribution ID is required when requesting data from a public contribution.',
						},
					],
				};
				return;
			}
			const contribution = await esGetContributionData({
				repository,
				id,
				key,
				format: ctx.accepts('text/plain') ? 'txt' : 'json',
            });
            let contributionString: string = "";
            if (contribution && typeof contribution === 'string') {
                contributionString = contribution;
            }
            if (contribution === undefined) {
                const contributionFile = await s3GetContributionByID({
                    id,
                    format: ctx.accepts('text/plain') ? 'txt' : 'json',
                });
                if (contributionFile && typeof contributionFile === 'string') {
                    contributionString = contributionFile;
                }
            }
            if (contributionString === "") {
				ctx.status = 204;
				return;
			}
			ctx.status = 200;
			ctx.body = contributionString;
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
};
