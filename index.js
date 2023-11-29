const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const { Storage } = require('@google-cloud/storage');
const mailgun = require('mailgun-js');
const secretsManager = new AWS.SecretsManager();
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function getSecret(secretName) {
    const data = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
    return JSON.parse(data.SecretString);
}

exports.handler = async (event) => {
    const googleCredentials = await getSecret('GoogleCloudSecretName');
    const mailgunCredentials = await getSecret('MailGunSecret');
    
    const storage = new Storage({ credentials: googleCredentials });
    const mg = mailgun({ apiKey: mailgunCredentials.apiKey, domain: mailgunCredentials.domain });

    const message = JSON.parse(event.Records[0].Sns.Message);
    const { submissionUrl, userEmail, assignmentId } = message;

    try {
        const content = await downloadFromGitHub(submissionUrl);
        if (!content || content.length === 0) {
            throw new Error('Invalid URL or empty content');
        }
        const timestamp = new Date().toISOString();
        const fileName = `${userEmail}/${assignmentId}/${timestamp}.zip`;
        const uploadedFileURL = await uploadToGoogleCloud(storage, content, 'your-bucket-name', fileName);
        await sendEmailNotification(mg, userEmail, `File uploaded: ${uploadedFileURL}`);
        await updateDynamoDB(dynamodb, userEmail, uploadedFileURL);
    } catch (error) {
        console.error('Error processing the Lambda function:', error);
        await sendEmailNotification(mg, userEmail, `Error: ${error.message}`);
        // Additional error handling
    }
};

async function downloadFromGitHub(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download: ${response.statusText}`);
    }
    return await response.buffer();
}

async function uploadToGoogleCloud(storage, content, bucketName, fileName) {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);
    await file.save(content);
    return `https://storage.googleapis.com/assignmentuploadsbucket/${fileName}`;
}

async function sendEmailNotification(mg, email, message) {
    const mailgunCredentials = await getSecret('MailGunSecret');
    const data = {
        from: mailgunCredentials.fromEmail,
        to: email,
        subject: 'Assignment Submission Status',
        text: message
    };
    await mg.messages().send(data);
}

async function updateDynamoDB(dynamodb, email, fileURL) {
    const params = {
        TableName: 'mytable',
        Item: { email, fileURL, timestamp: new Date().toISOString() }
    };
    await dynamodb.put(params).promise();
}
