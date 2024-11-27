// The purpose of this Lambda function is to poll the SQS queue for S3 URIs, determine
// if the S3 object has already been processed, and if not, passes it to Rekognition
// Text Detection and writes the results to a DynamoDB table. It then updates the
// S3 object tag as "processed"



const { S3Client, GetObjectTaggingCommand, PutObjectTaggingCommand } = require("@aws-sdk/client-s3");
const { RekognitionClient, DetectTextCommand } = require("@aws-sdk/client-rekognition");
const { SQSClient, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

const s3Client = new S3Client({});
const rekognitionClient = new RekognitionClient({});
const sqsClient = new SQSClient({});

exports.handler = async (event) => {
    // Process only one message at a time
    // The only S3 object extensions coming through the queue are .jpg, .jpeg, and .png
    const message = event.Records[0];
    const s3JSONString = message.body;
    const processedByRekognitionTextDetectionTag = 'rekognition_text_detection';

    try {
        // Message body will contain a JSON object like this (from S3 Batch Operations): {"bucket":"<bucket-name>","key":"<path>/<to>/<object>.<extension>","versionId":<version>}
        // Version isn't implemented at this point, and will use the latest object version
        const s3Object = JSON.parse(s3JSONString);
        const { bucket, key } = s3Object;
        const s3Uri = `s3://${bucket}/${key}`;

        console.log(`Processing S3 Object ${s3Uri}`);

        // Check if S3 object already has the "processed by Rekognition" tag
        const taggingResponse = await s3Client.send(
            new GetObjectTaggingCommand({
                Bucket: bucket,
                Key: key,
            })
        );
        
        const existingTags = taggingResponse.TagSet || [];
        const hasRekognitionTextDetectionTag = existingTags.some(
            (tag) => tag.Key === processedByRekognitionTextDetectionTag && tag.Value === 'true'
        );
        
        // If object has already been processed once, skip it
        // We are using S3 object tags to identify if it has been processed
        if (hasRekognitionTextDetectionTag) {
            console.log(`Object ${s3Uri} already processed, skipping`);
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Object already processed' })
            };
        }
        
        // Process image with Rekognition Text Detection
        // The default MinConfidence is 80 if you don't specify a value
        const rekognitionResponse = await rekognitionClient.send(
            new DetectTextCommand({
                Image: {
                    S3Object: {
                        Bucket: bucket,
                        Name: key,
                    },
                },
                Filters: {
                    MinConfidence: 90.0
                }
            })
        );
        
        console.log('Rekognition response:', JSON.stringify(rekognitionResponse, null, 2));
        
        // Process the rekognition response, and identify the words that it detects.
        
        // Get the detected text from the rekognition response, concatenate each of the detected text responses,
        // and concatenate them with the 'pipe' character. Filter the rekognition response by TYPE = 'LINE'
        const detectedText = rekognitionResponse.TextDetections.filter(
            (text) => text.Type === "LINE"
        )
            .map((text) => text.DetectedText)
            .join(" | ");

        // If any of the detected text includes the word to detect, add it to the final reporting
        // We use the WORD type here and not the LINE type
        // Case does not matter in this scenario because we want to have a DynamoDB attribute to filter results
        const wordDetected = rekognitionResponse.TextDetections.filter(
            (text) => text.Type === "WORD"
        )
            .some((text) => text.DetectedText
            .toLowerCase()
            .includes(process.env.WORD_TO_DETECT.toLowerCase()));

        // Get the dynamodb table name from the environment variable
        const dynamodbTableName = process.env.DYNAMODB_TABLE;
        
        // Write the Rekognition response to the DynamoDB table
        // We will use this table to scan/query the results, or export to CSV
        const dynamodbClient = new DynamoDBClient({});
        await dynamodbClient.send(
            new PutItemCommand({
                TableName: dynamodbTableName,
                Item: {
                    s3Uri: { S: s3Uri }, // S3 object
                    text_detected_flattened: { S: detectedText }, // detected text per line, separated by the 'pipe' character
                    contains_word: { BOOL: wordDetected ? true : false }, // will be used to query only the word we are looking for
                    // TODO: update attributes as necessary
                },
            })
        );
        
        // Tag already exists. Update the tag value of 'rekognition_text_detection' to 'true'
        if (existingTags.some(
            (tag) => tag.Key === processedByRekognitionTextDetectionTag && tag.Value === 'false'
        )) {
            await s3Client.send(
                new PutObjectTaggingCommand({
                    Bucket: bucket,
                    Key: key,
                    Tagging: {
                        TagSet: existingTags.map((tag) => {
                            if (tag.Key === processedByRekognitionTextDetectionTag) {
                                return {
                                    Key: tag.Key,
                                    Value: 'true',
                                };
                            }
                            return tag;
                        }),
                    },
                })
            );

            console.log(`Object ${s3Uri} already has a tag with key 'rekognition_text_detection' but with value 'false', update the tag value to 'true'`);
        }
        else {
            // Add the processed tag, but only if the object doesn't already have the maximum of 10 tags
            if (existingTags.length < 10) {
                // Adds the 'rekognition_text_detection' tag in addition to the existing tags
                await s3Client.send(
                    new PutObjectTaggingCommand({
                        Bucket: bucket,
                        Key: key,
                        Tagging: {
                            TagSet: [
                                ...existingTags,
                                {
                                    Key: processedByRekognitionTextDetectionTag,
                                    Value: 'true',
                                },
                            ],
                        },
                    })
                );

                console.log(`Added 'rekognition_text_detection' object tag to ${s3Uri}`);
            } else {
                console.log(`Object ${s3Uri} already had a maximum of 10 tags, skipping the addition of the new tag`);
            }
        }

        const arnParts = message.eventSourceARN.split(':');
        const accountId = arnParts[4];
        const queueName = arnParts[5];
        const region = message.awsRegion;

        const queueUrl = `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;

        // Delete message from SQS queue after successful processing
        await sqsClient.send(
            new DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.receiptHandle
            })
        );

        // Return success response with proper formatting
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: 'Processing completed successfully',
                rekognitionResults: rekognitionResponse
            })
        };
        
    } catch (error) {
        console.error('Error processing image:');
        throw error;
    }
};