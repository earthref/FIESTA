import { jest, describe, beforeAll, test, expect } from '@jest/globals';
import * as dotenv from 'dotenv';
import axios, { AxiosInstance } from 'axios';

dotenv.config();
jest.setTimeout(30000);
const v = 'v1';

describe(`FIESTA API ${v} Search Tests`, () => {
	let client: AxiosInstance;

	beforeAll(async () => {
		client = axios.create({
			baseURL: `http://localhost:${process.env.PORT}`,
			validateStatus: () => true,
		});
	});

	test(`GET /${v}/MagIC/search returns 404`, async () => {
		const res = await client.get(`/${v}/MagIC/search`);
		expect(res.status).toBe(404);
	});

	test(`GET /${v}/MagIC/search/contributions returns 10 or less results`, async () => {
		const res = await client.get(`/${v}/MagIC/search/contributions`);
		expect(res.status).toBe(200);
		expect(res.data).toHaveProperty('total');
		expect(res.data).toHaveProperty('size');
		expect(res.data.size).toBeLessThanOrEqual(10);
		expect(res.data).toHaveProperty('from');
		expect(res.data.from).toBe(0);
		expect(res.data).toHaveProperty('results');
		expect(res.data.results.length).toBeLessThanOrEqual(res.data.size);
	});

	test(`GET /${v}/MagIC/search/contributions returns 5 or less results`, async () => {
		const res = await client.get(
			`/${v}/MagIC/search/contributions?n_max_rows=5`
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

	test(`GET /${v}/MagIC/search/contributions query for "basalt" returns 800 or more results`, async () => {
		const res = await client.get(
			`/${v}/MagIC/search/contributions?query=basalt&n_max_rows=1`
		);
		expect(res.status).toBe(200);
		expect(res.data).toHaveProperty('total');
		expect(res.data.total).toBeGreaterThanOrEqual(800);
		expect(res.data).toHaveProperty('from');
		expect(res.data.from).toBe(0);
		expect(res.data).toHaveProperty('results');
		expect(res.data.results.length).toBeLessThanOrEqual(res.data.size);
	});
});
