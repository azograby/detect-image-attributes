// The purpose of this Lambda function is to process the S3 Inventory Report, and
// filter by the supported extension types for Rekognition, then send those S3 URIs
// to an SQS queue for processing



const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const sqsClient = new SQSClient();

// Rekognition only supports these file types
const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

// S3 Batch Operations invokes a Lambda function for each object in the S3 Inventory Report
exports.handler = async (event) => {
    const results = [];
    const task = event.tasks[0]; // there's only one task per object
    const invocationSchemaVersion = event.invocationSchemaVersion;

    try {
        const s3Key = task.s3Key;
        const s3VersionId = task.s3VersionId;
        const s3Bucket = task.s3BucketArn.split(':::')[1];

        // Check if file extension is supported
        const fileExtension = s3Key.toLowerCase().substring(s3Key.lastIndexOf('.'));
        if (!SUPPORTED_EXTENSIONS.includes(fileExtension)) {
            results.push({
                taskId: task.taskId,
                resultCode: 'Succeeded', // Ignore unsupported file extensions
                resultString: `Skipped - Unsupported file type: ${fileExtension}`
            });
        } else {
            // Prepare SQS message
            const messageBody = JSON.stringify({
                bucket: s3Bucket,
                key: s3Key,
                versionId: s3VersionId
            });

            // Send message to SQS to be processed (each S3 object sent to SQS)
            // Lambda then polls SQS to send to Rekognition
            await sqsClient.send(new SendMessageCommand({
                QueueUrl: process.env.SQS_QUEUE_URL,
                MessageBody: messageBody
            }));

            results.push({
                taskId: task.taskId,
                resultCode: 'Succeeded',
                resultString: 'Successfully queued for processing'
            });
        }
    } catch (error) {
        results.push({
            taskId: task.taskId,
            resultCode: 'TemporaryFailure', // Any other error, will try to redrive
            resultString: `Error processing task: ${error.message}`
        });
    }

    // Write the result to CloudWatch
    console.log(results);

    return {
        invocationSchemaVersion: invocationSchemaVersion,
        treatMissingKeysAs: "TemporaryFailure", // Missing results for an object will be tried again
        invocationId: event.invocationId,
        results: results
    };
};