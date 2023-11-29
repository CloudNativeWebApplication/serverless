const AWS = require('aws-sdk');
const fetch = require('node-fetch');
const { Storage } = require('@google-cloud/storage');
const mailgun = require('mailgun-js');
// const secretsManager = new AWS.SecretsManager();
const dynamodb = new AWS.DynamoDB.DocumentClient();
const { v4: uuidv4 } = require('uuid');

// async function getSecret(secretName) {
//     const data = await secretsManager.getSecretValue({ SecretId: secretName }).promise();
//     return JSON.parse(data.SecretString);
// }


exports.handler = async (event) => {
    console.log('Lambda function triggered by SNS:', JSON.stringify(event));
    console.log(`Mailgun API Key: ${process.env.MAILGUN_API_KEY}`);
    console.log(`Mailgun Domain: ${process.env.MAILGUN_DOMAIN}`);
    
    const googleCredentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT);
    const storage = new Storage({ credentials: googleCredentials });
    const bucketName = process.env.GCS_BUCKET_NAME;
    const tableName = process.env.DYNAMODB_TABLE_NAME;
    const mg = mailgun({ apiKey: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN });

    const message = JSON.parse(event.Records[0].Sns.Message);
    const { submissionUrl, userEmail, assignmentId } = message;

    try {
        const content = await downloadFromGitHub(submissionUrl);
        if (!content || content.length === 0) {
            throw new Error('Invalid URL: Unable to download the file.');
        }
        const timestamp = new Date().toISOString();
        const fileName = `${userEmail}/${assignmentId}/${timestamp}.zip`;
        const uploadedFileURL = await uploadToGoogleCloud(storage, content, bucketName, fileName);

        await sendEmailNotification(mg, userEmail, `Your assignment has been successfully uploaded. You can access the uploaded file here: ${uploadedFileURL}`);
    } catch (error) {
        console.error('Lambda Function Error:', error);
        await sendEmailNotification(mg, userEmail, `Error in assignment submission: ${error.message}`);
    }
};

async function downloadFromGitHub(url) {
    console.log('Step 1: Downloading from GitHub');
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('The provided URL for the assignment submission is invalid or the file could not be downloaded. Please check the URL and try again.');
    }
    return await response.buffer();
}

async function uploadToGoogleCloud(storage, content, bucketName, userEmail, fileName) {
    console.log('Step 2: Uploading to Google Cloud Storage');

    // Replace any characters in userEmail that are not valid in a file name
    const safeEmail = userEmail.replace(/[^a-zA-Z0-9]/g, "_");

    // Simplify the timestamp to just year, month, day, hour, minute, second
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").substring(0, 14);

    // Construct the new file name with userEmail and timestamp
    const newFileName = `${safeEmail}_${fileName}_${timestamp}`;

    const bucket = storage.bucket(bucketName);
    const file = bucket.file(newFileName);

    // Upload the file with the new file name
    await file.save(content);

    // Return the URL of the uploaded file
    return `https://storage.googleapis.com/${bucketName}/${encodeURIComponent(newFileName)}`;
}



async function sendEmailNotification(mg, email, message) {
    console.log('Step 3: Sending Email Notification');
    const data = {
        from: 'noreply@ankithreddy.me',
        to: email,
        subject: 'Your Assignment Submission', 
        text: message
    };
    const uniqueId = uuidv4();
    try {
        await mg.messages().send(data);
        await updateDynamoDB(dynamodb, uniqueId, email, new Date().toISOString(), message, "Mail Sent Sucessfully", "-");
    } catch (error) {
        console.error('Error sending email:', error);
        await updateDynamoDB(dynamodb, uniqueId, email, new Date().toISOString(), message, "Failed", error.message);
    }
}


async function updateDynamoDB(dynamodb, id, email, timestamp, message, status, errorMessage) {
    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME,
        Item: {
            id, 
            email, 
            timestamp, 
            emailContent:message, 
            status, 
            errorMessage
        }
    };
    await dynamodb.put(params).promise();
}





