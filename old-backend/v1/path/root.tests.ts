import { jest, describe, beforeAll, test, expect } from '@jest/globals';
import * as dotenv from 'dotenv';
import axios, { AxiosInstance } from 'axios';

dotenv.config();
jest.setTimeout(30000);
const v = 'v1';

describe(`FIESTA API ${v} Root Tests`, () => {
	let client: AxiosInstance;

	beforeAll(async () => {
		client = axios.create({
			baseURL: `http://localhost:${process.env.PORT}`,
			validateStatus: () => true,
		});
	});

	test(`GET /${v}/health-check returns 200`, async () => {
		const res = await client.get(`/${v}/health-check`, {
			headers: { Accept: 'text/plain' },
		});
		expect(res.status).toBe(200);
	});

	test(`GET /${v}/authenticate returns 401`, async () => {
		const res = await client.get(`/${v}/authenticate`, {
			headers: { Accept: 'text/plain' },
		});
		expect(res.status).toBe(401);
	});

	test(`GET /${v}/authenticate with incorrect basic auth returns 401`, async () => {
		const res = await client.get(`/${v}/authenticate`, {
			headers: { Accept: 'text/plain' },
			auth: {
				username: process.env.TEST_USERNAME,
				password: 'wrong',
			},
		});
		expect(res.status).toBe(401);
	});

	test(`GET /${v}/authenticate with correct basic auth returns 200`, async () => {
		const res = await client.get(`/${v}/authenticate`, {
			headers: { Accept: 'text/plain' },
			auth: {
				username: process.env.TEST_USERNAME,
				password: process.env.TEST_PASSWORD,
			},
		});
		expect(res.status).toBe(200);
	});
});
