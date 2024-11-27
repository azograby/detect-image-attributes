// The purpose of this file is to deploy all the AWS infrastructure necessary
// for this solution. Make sure to update the existing bucket name, and the 
// word to detect



import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// TODO: Separate infrastructure components into constructs
// TODO: Update this word to detect your desired text in the images. Case is ignored.
const wordToDetect = "findme";

export class DetectImageAttributesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The existing bucket where the assets are stored
    // TODO: update the bucket name to an existing bucket in your account
    const existingBucket = s3.Bucket.fromBucketName(this, 'ImportedBucket', "detect-image-attributes-rekognition");

    // Create IAM role for Lambda function that extracts text using Rekognition
    const role = new iam.Role(this, 'TextExtractorLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Create DynamoDB table to store results from Rekognition
    const table = new dynamodb.Table(this, 'ImageRecognitionMappingTable', {
      tableName: 's3-object-image-recognition-mapping',
      partitionKey: { name: 's3Uri', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableClass: dynamodb.TableClass.STANDARD_INFREQUENT_ACCESS
    });

    // Add DynamoDB permissions to the extractor Lambda role
    table.grantWriteData(role);

    // Add necessary permissions to the extractor Lambda role
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket', 's3:GetObjectVersion', 's3:GetObjectTagging', 's3:PutObjectTagging'],
      resources: [existingBucket.bucketArn, `${existingBucket.bucketArn}/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['rekognition:DetectText'],
      resources: ['*'],
    }));

    // Create dead letter queue
    const dlq = new sqs.Queue(this, 'DetectImageAttributesDLQ', {
      queueName: 'detect-image-attributes-dlq',
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(14),
    });

    // Create main SQS queue to process S3 objects using Rekognition
    const queue = new sqs.Queue(this, 'DetectImageAttributesQueue', {
      queueName: 'detect-image-attributes',
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(7),
      receiveMessageWaitTime: cdk.Duration.seconds(20), // Enable long polling
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // Add resource policy to DLQ to allow the main queue to send messages
    dlq.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('sqs.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [dlq.queueArn],
      conditions: {
        ArnEquals: {
          'aws:SourceArn': queue.queueArn
        }
      }
    }));

    // Add resource policy to allow any principal in the account to send messages
    queue.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['sqs:SendMessage'],
      resources: [queue.queueArn],
    }));

    // Retrieves an S3 object from the SQS queue, uses Rekognition to identify the words,
    // and writes results to a DynamoDB table
    const textExtractorLambda = new lambda.Function(this, 'text-extractor', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/text-extractor'),
      role: role,
      environment: {
        DYNAMODB_TABLE: table.tableName,
        WORD_TO_DETECT: wordToDetect,
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      description: 'Lambda function for extracting text from images',
    });

    // Configure extractor Lambda to poll from SQS queue
    textExtractorLambda.addEventSource(new SqsEventSource(queue, {
      batchSize: 1, // poll for one item at a time from the SQS queue
      maxBatchingWindow: cdk.Duration.seconds(0),
      maxConcurrency: 10, // process with 10 functions at a time. Rekognition has a default quota of 50 transactions per SECOND, 
      // so we are allowing only 10 to account for retries being invoked. Also, the function with the current settings executes
      // at an average of 500ms, but goes as low as around 200ms
    }));

    // Add SQS permissions to extractor Lambda role
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
      resources: [queue.queueArn],
    }));

    // **** S3 Batch SQS Lambda *****

    const s3BatchLambdaRole = new iam.Role(this, 'DetectImageTextS3BatchSQSLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Create Lambda function to process an S3 Inventory Report using S3 Batch Operations
    const batchProcessingLambda = new lambda.Function(this, 'DetectImageTextS3BatchSQS', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      role: s3BatchLambdaRole,
      code: lambda.Code.fromAsset('lambda/s3-batch-sqs'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: 100,
      description: 'Lambda function for sending S3 batch objects to SQS to process',
      environment: {
        SQS_QUEUE_URL: queue.queueUrl
      }
    });

    // Add necessary permissions to the role
    s3BatchLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));

    // Add SQS permissions to Lambda role
    s3BatchLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [queue.queueArn],
    }));

    // **** End S3 Batch SQS Lambda *****
  }
}
