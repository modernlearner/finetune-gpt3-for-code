require("dotenv").config();
const fs = require("fs");
const { parse: csvParseSync} = require("csv-parse/sync");
const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

const CSV_DATASET_PATH = "dataset.csv";
const JSONL_DATASET_PATH = "dataset.jsonl";

function convertCsvToJsonl(csvFilePath, jsonlFilePath) {
  const csvData = fs.readFileSync(csvFilePath, "utf8");
  const records = csvParseSync(csvData, {
    columns: true,
    skip_empty_lines: true,
    quote: '"',
    relax_column_count: true,
    onRecord: (record) => {
      const prompt = record[Object.keys(record)[0]];
      return { prompt, completion: record.completion };
    }
  });
  fs.writeFileSync(jsonlFilePath, records.map(JSON.stringify).join("\n"));
}

async function uploadDatasetAndFineTuneModel() {
  const uploadResponse = await openai.createFile(
    fs.createReadStream(JSONL_DATASET_PATH),
    "fine-tune"
  );
  const trainingFileId = uploadResponse.data.id;
  const createFineTuneResponse = await openai.createFineTune({
    model: "davinci",
    training_file: trainingFileId,
  });
  const fineTuneId = createFineTuneResponse.data.id;
  const retrieveFineTuneResponse = await openai.retrieveFineTune(fineTuneId);
  console.log(retrieveFineTuneResponse.data);
  return fineTuneId;
}

async function listFineTunes() {
  const listFineTunesResponse = await openai.listFineTunes();
  const fineTunes = listFineTunesResponse.data.data;
  for (const fineTune of fineTunes) {
    console.log(fineTune.id, fineTune.status, fineTune.fine_tuned_model);
  }
}

/**
 * Returns the completion generated from OpenAI GPT-3 using any model given the prompt.
 * @param {string} model The fine tune id or the id of another model
 * @param {string} prompt The prompt to generate the code completion for
 * @returns 
 */
async function generateCode(model, prompt) {
  return openai.createCompletion({ model, prompt });
}

if (process.argv.length == 2) {
  convertCsvToJsonl(CSV_DATASET_PATH, JSONL_DATASET_PATH);
  uploadDatasetAndFineTuneModel().then((fineTuneId) => {
    console.log(`Fine tune id: ${fineTuneId}`);
  });
} else if (process.argv.length == 3 && process.argv[2] == "list") {
  listFineTunes();
} else {
  const model = process.argv[2];
  const prompt = process.argv[3];
  generateCode(model, prompt).then((completion) => {
    console.log(completion.data.choices[0].text);
  });
}
