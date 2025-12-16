import lodash from 'lodash';
import deepdash from 'deepdash';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { Client, RequestParams, ApiResponse } from '@opensearch-project/opensearch';
import { isDev } from '../../api';

const _ = deepdash(lodash);

const indexes = { MagIC: 'magic' };
const usersIndex = 'er_users';
const client = new Client({
	node: process.env.ES_NODE,
});

function sleep(ms = 0) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms, '');
	});
}

// Complete definition of the Search response
interface ShardsResponse {
	total: number;
	successful: number;
	failed: number;
	skipped: number;
}

interface Explanation {
	value: number;
	description: string;
	details: Explanation[];
}

interface Hit {
	_index: string;
	_type: string;
	_id: string;
	_score: number;
	_source: any;
	_version?: number;
	_explanation?: Explanation;
	fields?: any;
	highlight?: any;
	inner_hits?: any;
	matched_queries?: string[];
	sort?: string[];
}

interface SearchResponse {
	took: number;
	timed_out: boolean;
	_scroll_id?: string;
	_shards: ShardsResponse;
	hits: {
		total: {
			value: number,
		};
		max_score: number;
		hits: Hit[];
	};
	aggregations?: any;
	err?: Explanation;
}

// Check the ES connection status
async function esCheckConnection(attempt = 0): Promise<boolean> {
	try {
		const health = await client.cluster.health({});
		return (
			health &&
			health.body &&
			(health.body.status === 'yellow' || health.body.status === 'green')
		);
	} catch (err) {
		if (process.env.NODE_ENV === 'development') {
			console.log('Connecting to ES Failed, Retrying...', err);
		}
	}
	if (attempt >= 5) {
		return false;
	}
	await sleep(100);
	return esCheckConnection(attempt + 1);
}
export { esCheckConnection };

// Authenticate a username and password
async function esAuthenticate(authorization: string): Promise<boolean | any> {
	const b64auth = (authorization || '').split(' ')[1] || '';
	const [username, password] = Buffer.from(b64auth, 'base64')
		.toString()
		.split(':');
	const resp: ApiResponse<SearchResponse> = await client.search({
		size: 1,
		index: usersIndex,
		body: {
			query: { term: { 'handle.raw': username.toLowerCase() } },
			sort: { id: 'desc' },
		},
	});
	if (resp.body.hits.total.value <= 0) {
		await sleep(500);
		return false;
	}
	let user = resp.body.hits.hits[0]._source;
	if (!bcrypt.compareSync(password, user._password)) {
		await sleep(500);
		return false;
	}
	user = _.omitDeep(user, /(^|\.)_/);
	user.has_password = true;
	return user;
}
export { esAuthenticate };

// Contribution data
async function esGetContributionData({
	repository,
	id = '',
	doi = '',
	key = '',
	format = 'txt',
}: {
	repository?: string;
	id?: string;
	doi?: string;
	key?: string;
	format?: 'txt' | 'json' | 'xls';
} = {}): Promise<Record<string, unknown>[]> {
	const doc = await esGetContribution({
		repository,
		id,
		doi,
		key,
		source: 'contribution',
	});
	if (!doc) return;
	if (format === 'txt') {
		const { Exporter: ExportContribution } = await import(
			'./export_contribution.js'
		);
		const exporter = new ExportContribution({});
		return exporter.toText(doc['contribution']);
	}
	if (format === 'json') {
		return doc['contribution'];
	}
}
export { esGetContributionData };

// Contribution summary
async function esGetContributionSummaryData({
	repository,
	table = '',
	id = '',
	doi = '',
	key = '',
}: {
	repository?: string;
	table?: string;
	id?: string;
	doi?: string;
	key?: string;
} = {}): Promise<Record<string, unknown>[]> {
	const doc = await esGetContribution({
		repository,
		id,
		doi,
		key,
		source: `summary${table ? `.${table}` : ''}`,
	});
	if (!doc) return;
	return table ? doc['summary'][table] : doc['summary'];
}
export { esGetContributionSummaryData };

// Get Contribution
async function esGetContribution({
	repository,
	id = '',
	doi = '',
	key = '',
	source = '',
}: {
	repository?: string;
	id?: string;
	doi?: string;
	key?: string;
	source?: string;
} = {}): Promise<Record<string, unknown>[]> {
	const must: Record<string, unknown>[] = [];
	if (id) must.push({ term: { 'summary.contribution.id': id } });
	if (doi)
		must.push({
			term: { 'summary.contribution._reference.doi.raw': doi.toUpperCase() },
		});
	if (key) must.push({ term: { 'summary.contribution._private_key': key } });
	must.push({ term: { type: 'contribution' } });
    // must.push({ term: { 'summary.contribution._is_activated': true } });
	const params: RequestParams.Search = {
		index: indexes[repository],
		_source: source,
		size: 1,
		body: {
			sort: { 'summary.contribution.timestamp': 'desc' },
			query: { bool: { must } },
		},
	};
	const resp: ApiResponse<SearchResponse> = await client.search(params);
	if (resp.body.hits.total.value <= 0) {
		return;
	}
	return resp.body.hits.hits[0]._source;
}
export { esGetContribution };

// Search public contributions
async function esGetSearchByTable({
	repository,
	table = 'contribution',
	size = 10,
	from = 0,
	queries = [],
	exists_fields = [],
	not_exists_fields = [],
	ids = [],
	dois = [],
    contributor_names = [],
    only_latest = false,
    reference_titles = [],
}: {
	repository?: string;
	table?: string;
	size?: number;
	from?: number;
	queries?: string[];
	exists_fields?: string[];
	not_exists_fields?: string[];
	ids?: string[];
	dois?: string[];
	contributor_names?: string[];
    only_latest?: boolean;
    reference_titles?: string[];
} = {}): Promise<{
	total: number;
	table: string;
	size: number;
	from: number;
	queries?: string[];
	exists_fields?: string[];
	not_exists_fields?: string[];
	results: any[];
} | undefined> {
	const must: Record<string, unknown>[] = [
		{ term: { 'summary.contribution._is_activated': true } },
	];
	const must_not: Record<string, unknown>[] = [];
	if (queries.length)
		queries.forEach((query) => must.push({ query_string: { query, default_operator: 'AND' } }));
	if (exists_fields.length)
		exists_fields.forEach((column) => must.push({ exists: { field: column } }));
	if (not_exists_fields.length)
		not_exists_fields.forEach((column) => must_not.push({ exists: { field: column } }));
	if (ids.length) must.push({ terms: { 'summary.contribution._history.id': ids } });
	if (dois.length)
		must.push({ terms: { 'summary.contribution._reference.doi.raw': dois.map(x => x.toUpperCase()) } });
	if (contributor_names.length)
		must.push({ terms: { 'summary.contribution._contributor.raw': contributor_names } });
	if (only_latest)
        must.push({ term: { 'summary.contribution._is_latest': true } });
    if (reference_titles.length)
        must.push({
            bool: {
                should: reference_titles.map(title =>
                    ({ match_phrase: { 'summary.contribution._reference.title.raw': title } })
                )
            }   
        });
    console.log(JSON.stringify({query: { bool: { must, must_not } }}))
	must.push({ term: { type: table } });
	const params: RequestParams.Search = {
		index: indexes[repository],
		size,
		from,
		_source_includes: ['summary.contribution', 'rows'],
		body: {
			sort: { 'summary.contribution.timestamp': 'desc' },
			query: { bool: { must, must_not } },
		},
	};
	const resp: ApiResponse<SearchResponse> = await client.search(params);
	if (resp.body.hits.total.value <= 0) {
		return;
	}
	const results =
		table !== 'contribution'
			? _.flatMap(resp.body.hits.hits, (hit: Hit) => hit._source.rows)
			: resp.body.hits.hits.map((hit) =>
				_.omitBy(
					hit._source.summary.contribution,
					(o: any, k: string) => k[0] === '_'
				)
			);
	return {
		total: resp.body.hits.total.value,
		table,
		size,
		from,
		queries,
		results,
	};
}
export { esGetSearchByTable };

// Search private contributions
async function esGetPrivateSearchByTable({
	repository,
	table,
	contributor,
	size = 10,
	from = 0,
	queries = [],
	exists_fields = [],
	not_exists_fields = [],
	ids = [],
	dois = [],
}: {
	repository?: string;
	table?: string;
	contributor?: string;
	size?: number;
	from?: number;
	queries?: string[];
	exists_fields?: string[];
	not_exists_fields?: string[];
	ids?: string[];
	dois?: string[];
} = {}): Promise<{
	total: number;
	table: string;
	size: number;
	from: number;
	queries?: string[];
	exists_fields?: string[];
	not_exists_fields?: string[];
	results: any[];
} | undefined> {
	const must: Record<string, unknown>[] = [
		{ term: { 'summary.contribution.contributor.raw': contributor } },
		{ term: { 'summary.contribution._is_activated': false } },
	];
	const must_not: Record<string, unknown>[] = [];
	if (queries.length)
		queries.forEach((query) => must.push({ query_string: { query } }));
	if (exists_fields.length)
		exists_fields.forEach((column) => must.push({ exists: { field: column } }));
	if (not_exists_fields.length)
		not_exists_fields.forEach((column) => must_not.push({ exists: { field: column } }));
	if (ids.length) must.push({ terms: { 'summary.contribution.id': ids } });
	if (dois.length)
		must.push({ terms: { 'summary.contribution._reference.doi.raw': dois } });
	must.push({ term: { type: table } });
	const params: RequestParams.Search = {
		index: indexes[repository],
		size,
		from,
		_source_includes: ['summary.contribution', 'rows'],
		body: {
			sort: { 'summary.contribution.timestamp': 'desc' },
			query: { bool: { must, must_not } },
		},
	};
	const resp: ApiResponse<SearchResponse> = await client.search(params);
	if (resp.body.hits.total.value <= 0) {
		return;
	}
	const results =
		table !== 'contribution'
			? _.flatMap(resp.body.hits.hits, (hit: Hit) => hit._source.rows)
			: resp.body.hits.hits.map((hit) =>
				_.omitBy(
					hit._source.summary.contribution,
					(o: any, k: string) => k[0] === '_'
				)
			);
	return {
		total: resp.body.hits.total.value,
		table,
		size,
		from,
		queries,
		exists_fields,
		not_exists_fields,
		results,
	};
}
export { esGetPrivateSearchByTable };

// Replace a private contribution
async function esReplacePrivate({
	repository,
	contributor,
	id,
	doc,
}: {
	repository?: string;
	contributor?: string;
	id?: number;
	doc?: any;
} = {}): Promise<void> {
	const params: RequestParams.UpdateByQuery = {
		index: indexes[repository],
		body: {
			script: {
				source: 'ctx._source = params.doc',
				params: { doc },
			},
			query: {
				bool: {
					must: [
						{ term: { 'summary.contribution.contributor.raw': contributor } },
						{ term: { 'summary.contribution.id': id } },
						{ term: { type: 'contribution' } },
					],
				},
			},
		},
	};
	await client.updateByQuery(params);
}
export { esReplacePrivate };

// Create a private contribution
async function esCreatePrivate({
	repository,
	contributor,
	contributorName,
}: {
	repository?: string;
	contributor?: string;
	contributorName?: string;
} = {}): Promise<number> {
	const lastResp: ApiResponse<SearchResponse> = await client.search({
		index: indexes[repository],
		body: {
			size: 1,
			_source: 'summary.contribution.id',
			query: {
				bool: {
					must: [
						{
							exists: {
								field: 'summary.contribution.id',
							}
						},
						{ term: { type: 'contribution' } },
					],
				},
			},
			sort: [
				{
					'summary.contribution.id': 'desc',
				},
			],
		},
	});
	const lastID = lastResp.body.hits.hits[0]._source.summary.contribution.id;
	if (isNaN(_.parseInt(lastID))) {
		throw new Error('Failed to retrieve new contribution ID.');
	}
	const nextID = _.parseInt(lastID) + 1;
	const timestamp = DateTime.utc().toISO();
	await client.index({
		index: indexes[repository],
		id: `${nextID}_0`,
		refresh: true,
		body: {
			type: "contribution",
			summary: {
				contribution: {
					id: nextID,
					version: 1,
					contributor: contributor,
					timestamp: timestamp,
					data_model_version: '3.0',
					_contributor: contributorName,
					_name: 'My Contribution',
					_is_activated: 'false',
					_is_latest: 'true',
					_private_key: uuidv4(),
					_history: [
						{
							id: nextID,
							version: 1,
							contributor: contributorName,
							timestamp: timestamp,
							data_model_version: '3.0',
						},
					],
				},
			},
			contribution: {
				contribution: [
					{
						contributor: contributor,
						id: nextID,
						version: 1,
						timestamp: timestamp,
						data_model_version: '3.0',
					},
				],
			},
		},
	});
	return nextID;
}
export { esCreatePrivate };

// Create a private contribution
async function esDeletePrivate({
	repository,
	contributor,
	id,
}: {
	repository?: string;
	contributor?: string;
	id?: string;
} = {}): Promise<number> {
	const params = {
		index: indexes[repository],
		body: {
			query: {
				bool: {
					must: [
						{
							term: {
								'summary.contribution.contributor.raw': contributor,
							},
						},
						{
							term: {
								'summary.contribution.id': id,
							},
						},
					],
				},
			},
		},
	};
	await client.deleteByQuery(params);
	return 1;
}
export { esDeletePrivate };

// Get a private contribution
async function esGetPrivate({
	repository,
	contributor,
	key,
	id,
	format,
}: {
	repository?: string;
	contributor?: string;
	key?: string;
	id?: number;
	format?: 'txt' | 'json' | 'xls';
} = {}): Promise<string> {
	if (!format) return;
	const must: Record<string, unknown>[] = [
		contributor
			? { term: { 'summary.contribution.contributor.raw': contributor } }
			: { term: { 'summary.contribution._private_key.raw': key } },
		{ term: { 'summary.contribution._is_activated': false } },
		{ term: { 'summary.contribution.id': id } },
		{ term: { type: 'contribution' } },
	];
	const params: RequestParams.Search = {
		index: indexes[repository],
		body: {
			sort: { 'summary.contribution.timestamp': 'desc' },
			query: { bool: { must } },
		},
	};
	const resp: ApiResponse<SearchResponse> = await client.search(params);
	if (resp.body.hits.total.value <= 0) {
		return;
	}
	if (format === 'txt') {
		const { Exporter: ExportContribution } = await import(
			'./export_contribution.js'
		);
		const exporter = new ExportContribution({});
		return exporter.toText(resp.body.hits.hits[0]._source.contribution);
	}
	if (format === 'json') {
		return resp.body.hits.hits[0]._source.contribution;
	}
	if (format === 'xls') {
		const { Exporter: ExportContribution } = await import(
			'./export_contribution.js'
		);
		const exporter = new ExportContribution({});
		return exporter.toText(resp.body.hits.hits[0]._source.contribution);
	}
}
export { esGetPrivate };

async function esValidatePrivateContribution({
	repository,
	contributor,
	id,
}: {
	repository?: string;
	contributor?: string;
	id?: number;
} = {}): Promise<string> {
	const must: Record<string, unknown>[] = [
		{ term: { 'summary.contribution.id': id } },
		{ term: { type: 'contribution' } },
	];
	if (!isDev) {
		must.push({
			term: { 'summary.contribution.contributor.raw': contributor },
		});
		must.push({ term: { 'summary.contribution._is_activated': false } });
	}
	const params: RequestParams.Search = {
		index: indexes[repository],
		body: {
			sort: { 'summary.contribution.timestamp': 'desc' },
			query: { bool: { must } },
		},
	};
	const resp: ApiResponse<SearchResponse> = await client.search(params);
	if (resp.body.hits.total.value <= 0) {
		return;
	}
	if (
		resp.body.hits.total.value > 0 &&
		resp.body.hits.hits[0]._source.contribution &&
		_.isPlainObject(resp.body.hits.hits[0]._source.contribution.contribution)
	)
		resp.body.hits.hits[0]._source.contribution.contribution = [
			resp.body.hits.hits[0]._source.contribution.contribution,
		];

	const { Validator: ValidateContribution } = await import(
		'./validate_contribution.js'
	);
	const validator = new ValidateContribution({});
	await validator.validatePromise(resp.body.hits.hits[0]._source.contribution);

	await client.update({
		index: indexes[repository],
		id: id + '_0',
		body: {
			doc: {
				summary: {
					contribution: {
						_is_valid: validator.validation.errors.length ? 'false' : 'true',
					},
				},
			},
		},
	});

	return validator.validation;
}
export { esValidatePrivateContribution };
