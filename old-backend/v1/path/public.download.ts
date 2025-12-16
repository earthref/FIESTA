import { Context as OpenAPIContext } from 'openapi-backend/backend';
import Koa from 'koa';
import * as fs from 'fs';
import { default as archiver } from 'archiver';
import { DateTime } from 'luxon';
import { s3GetContributionByID } from '../libs/s3';
import { esGetSearchByTable } from '../libs/es';

export default {
	v1PublicDownloadFiles: async (
		c: OpenAPIContext,
		ctx: Koa.Context
	): Promise<void> => {
		try {
			const { repository: repositories } = c.request.params;
			const { n_max_contributions, query, id, doi, contributor_name, only_latest, reference_title } =
				c.request.query;
			if (
				query === undefined &&
				id === undefined &&
				doi === undefined &&
				contributor_name === undefined &&
				reference_title === undefined
			) {
				ctx.status = 400;
				ctx.body = {
					errors: [{ message: 'At least one query parameter is required.' }],
				};
				return;
			}
			// const fileTypes: string[] = c.request.query.file_type instanceof Array ? c.request.query.file_type : [c.request.query.file_type];
			const size: number = parseInt(
				n_max_contributions instanceof Array
					? n_max_contributions[0]
					: n_max_contributions,
				10
			);
			const repository: string =
				repositories instanceof Array ? repositories[0] : repositories;
			const queries: string[] = query instanceof Array ? query : [query];
			const ids: string[] = id instanceof Array ? id : [id];
			const dois: string[] = doi instanceof Array ? doi : [doi];
            const contributor_names: string[] = contributor_name instanceof Array ? contributor_name : [contributor_name];
            const reference_titles: string[] = reference_title instanceof Array ? reference_title : [reference_title];
			const contributions = await esGetSearchByTable({
				repository,
				table: 'contribution',
				size: n_max_contributions !== undefined ? size : 10,
				queries: query !== undefined ? queries : undefined,
				ids: id !== undefined ? ids : undefined,
				dois: doi !== undefined ? dois : undefined,
                contributor_names: contributor_name !== undefined ? contributor_names : undefined,
                only_latest: only_latest !== undefined ? true : false,
                reference_titles: reference_title !== undefined ? reference_titles : undefined,
			});
			if (contributions === undefined || contributions.results.length === 0) {
				ctx.status = 204;
				return;
			}
			const cids = contributions.results.map((contribution) => contribution.id);
			const archive = archiver('zip');
			const fileName = `MagIC Download - Public - ${DateTime.utc()
				.toISO()
				.replace(/(-|:)/g, '')}.zip`;
			let emptyArchive = true;
			await Promise.all(
				cids.map(async (cid) => {
					const contributionFile = await s3GetContributionByID({
						id: cid,
						format: ctx.accepts('text/plain') ? 'txt' : 'json',
					});
					if (contributionFile) {
						archive.append(contributionFile, {
							name: `${cid}/magic_contribution_${cid}.txt`,
						});
						emptyArchive = false;
					}
				})
			);
			if (!emptyArchive) {
				if (!fs.existsSync('downloads')) {
					fs.mkdirSync('downloads');
				}
				await new Promise((resolve, reject) => {
					archive.pipe(fs.createWriteStream(`downloads/${fileName}`));
					archive.on('end', resolve);
					archive.on('error', (error: archiver.ArchiverError) => {
						reject();
						throw new Error(
							`${error.name} ${error.code} ${error.message} ${error.path} ${error.stack}`
						);
					});
					archive.finalize();
				});
				ctx.body = fs
					.createReadStream(`downloads/${fileName}`)
					.on('end', () => {
						fs.unlinkSync(`downloads/${fileName}`);
					});
				ctx.type = 'application/zip';
				ctx.response.attachment(fileName);
			} else {
				ctx.status = 500;
				ctx.body = {
					errors: [
						{
							message: `Failed to retrieve contributions [${cids.join(
								', '
							)}] for download.`,
						},
					],
				};
			}
		} catch (e) {
			ctx.app.emit('error', e, ctx);
			ctx.status = 500;
			ctx.body = { errors: [{ message: e.message }] };
		}
	},
};
