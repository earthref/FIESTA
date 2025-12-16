import { jest, describe, beforeAll, test, expect } from '@jest/globals';
import * as dotenv from 'dotenv';
import axios, { AxiosInstance } from 'axios';
import unzipper from 'unzipper';

dotenv.config();
jest.setTimeout(30000);
const v = 'v1';

describe(`FIESTA API ${v} Download Tests`, () => {
	let client: AxiosInstance;

	beforeAll(async () => {
		client = axios.create({
			baseURL: `http://localhost:${process.env.PORT}`,
			validateStatus: () => true,
		});
	});

	test(
		`GET /${v}/MagIC/download should return status 400 - ` +
		`either a contribution ID or query parameters are required`,
		async () => {
			const res = await client.get(`/${v}/MagIC/download`);
			expect(res.status).toBe(400);
			expect(res.data).toHaveProperty('errors');
		}
	);

	test(
		`POST /${v}/MagIC/download should return status 404 - ` +
		`POST is not defined for the download path`,
		async () => {
			const res = await client.post(`/${v}/MagIC/download`);
			expect(res.status).toBe(404);
		}
	);

	test(
		`GET /${v}/MagIC/download?id=1 should return status 204 - ` +
		`there are no public contributions with this contribution ID`,
		async () => {
			const res = await client.get(`/${v}/MagIC/download?id=1`);
			expect(res.status).toBe(204);
		}
	);

	test(
		`GET /${v}/MagIC/download?id=[latest contribution ID] should return status 200 - ` +
		`there is always one recent contribution to download`,
		async () => {
			const latestRes = await client.get(
				`/${v}/MagIC/search/contributions?n_max_rows=1`
			);
			const latestCID = latestRes.data.results[0].id;
			const res = await client.get(`/${v}/MagIC/download?id=${latestCID}`);
			expect(res.status).toBe(200);
		}
	);

	test(
		`GET /${v}/MagIC/download?id=1a should return status 400 with validation error - ` +
		`1a is not an integer and there is not contribution ID match`,
		async () => {
			const res = await client.get(`/${v}/MagIC/download?id=1a`);
			expect(res.status).toBe(400);
			expect(res.data).toHaveProperty('errors');
		}
	);

	test(
		`GET /${v}/MagIC/download?doi=10.1029/JZ072I012P03247 should return status 200 - ` +
		`there are public contributions with this reference DOI`,
		async () => {
			const res = await client.get(
				`/${v}/MagIC/download?doi=10.1029/JZ072I012P03247`
			);
			expect(res.status).toBe(200);
		}
	);

	test(
		`GET /${v}/MagIC/download?doi=10.1029/jz072i012p03247 should return status 200 - ` +
		`there are public contributions with this reference DOI`,
		async () => {
			const res = await client.get(
				`/${v}/MagIC/download?doi=10.1029/jz072i012p03247`
			);
			expect(res.status).toBe(200);
		}
	);

	test(
		`GET /${v}/MagIC/download?id=1&id=16595&id=16761 should return status 200 - ` +
		`there are public contributions for the second and third contribution IDs`,
		async () => {
			const res = await client.get(
				`/${v}/MagIC/download?id=1&id=16595&id=16761`,
				{ responseType: 'stream' }
			);
			expect(res.status).toBe(200);
			const paths: string[] = [];
			await res.data
				.pipe(unzipper.Parse())
				.on(`entry`, (entry: any) => {
					paths.push(entry.path);
					entry.autodrain();
				})
				.promise();
			expect(paths.length).toBeGreaterThanOrEqual(2);
			expect(paths).toContain('16595/magic_contribution_16595.txt');
			expect(paths).toContain('16761/magic_contribution_16761.txt');
		}
	);

	test(
		`GET /${v}/MagIC/download?id=16760&only_latest=true should return status 200 - ` +
		`and only one contribution should be downloaded`,
		async () => {
			const res = await client.get(
				`/${v}/MagIC/download?id=16760&only_latest=true`,
				{ responseType: 'stream' }
			);
			expect(res.status).toBe(200);
			const paths: string[] = [];
			await res.data
				.pipe(unzipper.Parse())
				.on(`entry`, (entry: any) => {
					paths.push(entry.path);
					entry.autodrain();
				})
				.promise();
			expect(paths.length).toBe(1);
		}
	);

	test(
		`GET /${v}/MagIC/download?id=16760&only_latest=true should return status 200 - ` +
		`and only one contribution should be downloaded`,
		async () => {
			const res = await client.get(
				`/${v}/MagIC/download?id=16760&only_latest=true`,
				{ responseType: 'stream' }
			);
			expect(res.status).toBe(200);
			const paths: string[] = [];
			await res.data
				.pipe(unzipper.Parse())
				.on(`entry`, (entry: any) => {
					paths.push(entry.path);
					entry.autodrain();
				})
				.promise();
			expect(paths.length).toBe(1);
		}
	);

	test(
		`GET /${v}/MagIC/download?reference_title=Geology of the Wilkes land sub-basin and stability of the East Antarctic Ice Sheet: Insights from rock magnetism at IODP Site U1361&only_latest=true should return status 200 - ` +
		`and only one contribution should be downloaded`,
		async () => {
			const res = await client.get(
				`/${v}/MagIC/download?reference_title=Geology%20of%20the%20Wilkes%20land%20sub-basin%20and%20stability%20of%20the%20East%20Antarctic%20Ice%20Sheet%3A%20Insights%20from%20rock%20magnetism%20at%20IODP%20Site%20U1361&only_latest=true`,
				{ responseType: 'stream' }
			);
			expect(res.status).toBe(200);
			const paths: string[] = [];
			await res.data
				.pipe(unzipper.Parse())
				.on(`entry`, (entry: any) => {
					paths.push(entry.path);
					entry.autodrain();
				})
				.promise();
			expect(paths.length).toBe(1);
		}
	);
});
