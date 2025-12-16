import AWS from 'aws-sdk';

const s3 = new AWS.S3({
	apiVersion: '2006-03-01',
	accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
	secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
});

async function s3GetObjectUTF8({
	Bucket,
	Key,
}: {
	Bucket: string;
	Key: string;
}): Promise<string | boolean> {
	try {
		const data = await s3.getObject({ Bucket, Key }).promise();
		return data.Body.toString('utf-8');
	} catch (e) {
		if (e.name === 'NoSuchKey') {
			return false;
		}
		throw e;
	}
}
export { s3GetObjectUTF8 };

async function s3GetContributionByID({
	id,
	format = 'txt',
}: {
	id: string;
	format: 'json' | 'txt';
}): Promise<string | boolean> {
	try {
		return s3GetObjectUTF8({
			Bucket: `magic-activated-contributions/${id}`,
			Key: `magic_contribution_${id}.${format}`,
		});
	} catch (e) {
		if (e.name === 'NoSuchKey') {
			return false;
		}
		throw e;
	}
}
export { s3GetContributionByID };
