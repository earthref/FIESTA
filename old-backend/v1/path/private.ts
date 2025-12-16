import _ from 'lodash';
import fs from 'fs';
import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';
import {
	esAuthenticate,
	esCreatePrivate,
	esDeletePrivate,
	esReplacePrivate,
	esGetContribution,
} from '../libs/es';

export default {
	v1PrivateCreate: async (
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
			if (!user.handle) {
				ctx.body = {
					errors: [
						{
							message:
								'Account handle is blank. Please log in to EarthRef.org and choose a unique handle.',
						},
					],
				};
				ctx.status = 500;
				return;
			}
			const { repository: repositories } = c.request.params;
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			ctx.status = 201;
			ctx.body = {
				id: await esCreatePrivate({
					repository,
					contributor: user.handle ? `@${user.handle}` : `@user${user.id}`,
					contributorName: `${user.name.given} ${user.name.family}`,
				}),
			};
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
	v1PrivateUpdate: async (
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
			const contributor = user.handle ? `@${user.handle}` : `@user${user.id}`;
			const { repository: repositories } = c.request.params;
			const { id: ids } = c.request.query;
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			const prevID: string = ids instanceof Array ? ids[0] : ids;
			const prevDoc = await esGetContribution({
				repository,
				id: prevID,
			});
			if (prevDoc === undefined) {
				ctx.status = 202;
				return;
			}
			let id: number = prevDoc['summary']['contribution']['id'];
			const prevContributionSummary = prevDoc['summary']['contribution'];

			// Check that the contribution can be updated.
			const prevHandle = prevContributionSummary['contributor'];
			const nextHandle = user.handle ? `@${user.handle}` : `@user${user.id}`;
			if (prevHandle !== '@magic' && prevHandle !== nextHandle) {
				ctx.body = {
					errors: [
						{
							message: `The contribution with ID ${id} is owned by another contributor.`,
						},
					],
				};
				ctx.status = 401;
				return;
			}

			// Create a new private contribution if this contribution is public.
			if (prevContributionSummary['is_activated'] === 'true') {
				id = await esCreatePrivate({
					repository,
					contributor,
					contributorName: `${user.name.given} ${user.name.family}`,
				});
			}
			const doc = { type: "contribution", contribution: prevDoc['contribution'] || {}, summary: {} };

			// Parse the files and overwrite contribution tables
			const { Parser: ParseContribution } = await import(
				'../libs/parse_contribution.js'
            );
            const files = Array.isArray(c.request.body.files.file) ? c.request.body.files.file : [c.request.body.files.file];
            for(const file of files) {
                const parser = new ParseContribution({});
                const fileText = fs.readFileSync(file.path).toString()
                await parser.parsePromise({ text: fileText });
                fs.writeFileSync(
                    `magic_doc_${id}_parser_ew.json`,
                    JSON.stringify(parser.errorsAndWarnings(), null, 2)
                );

                doc.contribution = { ...doc.contribution, ...parser.json };
                doc.contribution['contribution'] =
                    prevDoc['contribution']['contribution'];
                fs.writeFileSync(
                    `magic_doc_${id}_prev.json`,
                    JSON.stringify(doc, null, 2)
                );
                fs.writeFileSync(
                    `magic_doc_${id}_prev_summary.json`,
                    JSON.stringify(prevContributionSummary, null, 2)
                );

                // Summerize the contribution
                const { Summarizer: SummarizeContribution } = await import(
                    '../libs/summarize_contribution.js'
                );
                const summarizer = new SummarizeContribution({});
                await summarizer.preSummarizePromise(doc.contribution, {
                    summary: { contribution: prevContributionSummary },
                });
                fs.writeFileSync(
                    `magic_doc_${id}_presummarizer.json`,
                    JSON.stringify(summarizer.json, null, 2)
                );
                fs.writeFileSync(
                    `magic_doc_${id}_presummarizer_ew.json`,
                    JSON.stringify(summarizer.errorsAndWarnings(), null, 2)
                );
                doc.summary = summarizer.json.contribution.summary;

            }
                
            // Index with summary
            await esReplacePrivate({
                repository,
                contributor,
                id,
                doc,
            });

			ctx.status = 202;
			ctx.body = {
                id: id
			};
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
	v1PrivateAppend: async (
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
			const contributor = user.handle ? `@${user.handle}` : `@user${user.id}`;
			const { repository: repositories } = c.request.params;
			const { id: ids } = c.request.query;
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			const prevID: string = ids instanceof Array ? ids[0] : ids;
			const prevDoc = await esGetContribution({
				repository,
				id: prevID,
			});
			if (prevDoc === undefined) {
				ctx.status = 202;
				return;
			}
			let id: number = prevDoc['summary']['contribution']['id'];
			const prevContributionSummary = prevDoc['summary']['contribution'];

			// Check that the contribution can be updated.
			const prevHandle = prevContributionSummary['contributor'];
			const nextHandle = user.handle ? `@${user.handle}` : `@user${user.id}`;
			if (prevHandle !== '@magic' && prevHandle !== nextHandle) {
				ctx.body = {
					errors: [
						{
							message: `The contribution with ID ${id} is owned by another contributor.`,
						},
					],
				};
				ctx.status = 401;
				return;
			}

			// Create a new private contribution if this contribution is public.
			if (prevContributionSummary['is_activated'] === 'true') {
				id = await esCreatePrivate({
					repository,
					contributor,
					contributorName: `${user.name.given} ${user.name.family}`,
				});
			}
			const doc = { type: "contribution", contribution: prevDoc['contribution'] || {}, summary: {} };
            let rows_added = 0;

			// Parse the files and overwrite contribution tables
			const { Parser: ParseContribution } = await import(
				'../libs/parse_contribution.js'
            );
            const files = Array.isArray(c.request.body.files.file) ? c.request.body.files.file : [c.request.body.files.file];
            for(const file of files) {
                const parser = new ParseContribution({});
                const fileText = fs.readFileSync(file.path).toString()
                await parser.parsePromise({ text: fileText });
                fs.writeFileSync(
                    `magic_doc_${id}_parser_ew.json`,
                    JSON.stringify(parser.errorsAndWarnings(), null, 2)
                );

                _.keys(parser.json).forEach(table => {
                    doc.contribution[table] ||= [];
                    rows_added += parser.json[table].length;
                    doc.contribution[table].push(...parser.json[table]);
                })

                doc.contribution['contribution'] =
                    prevDoc['contribution']['contribution'];
                fs.writeFileSync(
                    `magic_doc_${id}_prev.json`,
                    JSON.stringify(doc, null, 2)
                );
                fs.writeFileSync(
                    `magic_doc_${id}_prev_summary.json`,
                    JSON.stringify(prevContributionSummary, null, 2)
                );

                // Summerize the contribution
                const { Summarizer: SummarizeContribution } = await import(
                    '../libs/summarize_contribution.js'
                );
                const summarizer = new SummarizeContribution({});
                await summarizer.preSummarizePromise(doc.contribution, {
                    summary: { contribution: prevContributionSummary },
                });
                fs.writeFileSync(
                    `magic_doc_${id}_presummarizer.json`,
                    JSON.stringify(summarizer.json, null, 2)
                );
                fs.writeFileSync(
                    `magic_doc_${id}_presummarizer_ew.json`,
                    JSON.stringify(summarizer.errorsAndWarnings(), null, 2)
                );
                doc.summary = summarizer.json.contribution.summary;

            }

			// Index with summary
			await esReplacePrivate({
				repository,
				contributor,
				id,
				doc,
			});

			ctx.status = 202;
            ctx.body = {
                id: id,
				rows_added: rows_added
			};
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
	v1PrivateDelete: async (
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
			if (!user.handle) {
				ctx.body = {
					errors: [
						{
							message:
								'Account handle is blank. Please log in to EarthRef.org and choose a unique handle.',
						},
					],
				};
				ctx.status = 500;
				return;
			}
			const { repository: repositories } = c.request.params;
			const { id: ids } = c.request.query;
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			const id: string = ids instanceof Array ? ids[0] : ids;
			ctx.status = 200;
			ctx.body = {
				rowsDeleted: await esDeletePrivate({
					repository,
					contributor: user.handle ? `@${user.handle}` : `@user${user.id}`,
					id,
				}),
			};
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
};
