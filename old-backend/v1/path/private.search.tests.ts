import { jest, describe, beforeAll, test, expect } from '@jest/globals';
import * as dotenv from 'dotenv';
import axios, { AxiosInstance } from 'axios';

dotenv.config();
jest.setTimeout(60000);
const v = 'v1';

describe(`FIESTA API ${v} Private Search Tests`, () => {
	let client: AxiosInstance;

	beforeAll(async () => {
		client = axios.create({
			baseURL: `http://localhost:${process.env.PORT}`,
			validateStatus: () => true,
		});
	});

	test(`GET /${v}/MagIC/private/search returns 404`, async () => {
		const res = await client.get(`/${v}/MagIC/private/search`);
		expect(res.status).toBe(404);
	});

	test(`GET /${v}/MagIC/private/search/contributions returns 401`, async () => {
		const res = await client.get(`/${v}/MagIC/private/search/contributions`);
		expect(res.status).toBe(401);
	});

	test(`GET /${v}/MagIC/private/search/contributions returns 10 or less results`, async () => {
		const res = await client.get(`/${v}/MagIC/private/search/contributions`, {
			auth: {
				username: process.env.TEST_USERNAME,
				password: process.env.TEST_PASSWORD,
			},
		});
		expect(res.status).toBe(200);
		expect(res.data).toHaveProperty('total');
		expect(res.data).toHaveProperty('size');
		expect(res.data.size).toBeLessThanOrEqual(10);
		expect(res.data).toHaveProperty('from');
		expect(res.data.from).toBe(0);
		expect(res.data).toHaveProperty('results');
		expect(res.data.results.length).toBeLessThanOrEqual(res.data.size);
	});

	test(`GET /${v}/MagIC/private/search/contributions returns 5 or less results`, async () => {
		const res = await client.get(
			`/${v}/MagIC/private/search/contributions?n_max_rows=5`,
			{
				auth: {
					username: process.env.TEST_USERNAME,
					password: process.env.TEST_PASSWORD,
				},
			}
		);
		expect(res.status).toBe(200);
		expect(res.data).toHaveProperty('total');
		expect(res.data).toHaveProperty('size');
		expect(res.data.size).toBeLessThanOrEqual(5);
		expect(res.data).toHaveProperty('from');
		expect(res.data.from).toBe(0);
		expect(res.data).toHaveProperty('results');
		expect(res.data.results.length).toBeLessThanOrEqual(res.data.size);
	});
});
