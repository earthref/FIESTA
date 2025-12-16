import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';

export default {
	v1ContributionValidate: async (
		c: OpenAPIContext,
		ctx: Koa.Context
	): Promise<void> => {
		try {
			// Parse the contribution
			const { Parser: ParseContribution } = await import(
				'../libs/parse_contribution.js'
			);
			const parser = new ParseContribution({});
			await parser.parsePromise({ text: c.request.body });

			// Validate the contribution
			const { Validator: ValidateContribution } = await import(
				'../libs/validate_contribution.js'
			);
			const validator = new ValidateContribution({});
			await validator.validatePromise(parser.json);
			ctx.status = 200;
			ctx.body = { validation: validator.validation };
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
};
