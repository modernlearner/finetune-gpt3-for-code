if (process.env.DOCKER_RUNNING) {
  require("dotenv").config();
}

const fs = require("fs");
const path = require("path");
const { parse: csvParseSync} = require("csv-parse/sync");
const { Configuration, OpenAIApi } = require("openai");
const typescript = require("typescript");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

const CSV_DATASET_PATH = process.env.DOCKER_RUNNING ? "/data/dataset.csv" : "data/dataset.csv";
const JSONL_DATASET_PATH = process.env.DOCKER_RUNNING ? "/data/dataset.jsonl" : "data/dataset.jsonl";

const debug = process.env.DEBUG.includes("true") ? (message) => console.log(message) : () => {};

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
 * Stores a CSV file of the parsed source code in the `output/` directory.
 * @param {*} sourceCodeFilePath 
 */
function parseSourcecode(sourceCodeFilePath) {
  const program = typescript.createProgram([sourceCodeFilePath], { allowJs: true});
  const printer = typescript.createPrinter({ newLine: typescript.NewLineKind.LineFeed });
  const sourceFile = program.getSourceFile(sourceCodeFilePath);
  debug(`Parsing ${sourceCodeFilePath}...`);
  parseNode(sourceFile);
  function parseNode(node) {
    const completion = printer.printNode(typescript.EmitHint.Unspecified, node, sourceFile);
    const prompts = [];

    // console.log(node);
    if (typescript.isArrowFunction(node)) {

      // console.log(Object.keys(node));
      const params = node.parameters.map(node => node.name.escapedText).join(", ");
      if (node.parameters.length === 0) {
        prompts.push("function");
        prompts.push("function with no parameters");
      } else if (node.parameters.length === 1) {
        prompts.push(`function with ${params} parameter`);
      } else {
        prompts.push(`function with ${params} parameters`);
      }
    }

    for (const prompt of prompts) {
      // TODO: save this to a CSV file
      console.log(`"${prompt}","${completion}"\n`);
    }

    typescript.forEachChild(node, parseNode);
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

debug("Fine Tuning GPT-3");
yargs(hideBin(process.argv))
  .command(
    "list",
    "list the fine tunes and their status",
    {},
    () => {
      debug("Listing fine tunes");
      listFineTunes();
    }
  )
  .command(
    "generate <model> <prompt>",
    "Generates code using the fine-tuned model given a prompt",
    {},
    (argv) => {
      debug("Generating code");
      generateCode(argv.model, argv.prompt).then((completion) => {
        console.log(completion.data.choices[0].text);
      });
    }
  )
  .command(
    ["upload", "$0"],
    "upload the dataset after converting it to JSONL from CSV and create a fine tuned model",
    {},
    () => {
      debug("Uploading dataset and fine tuning model");
      convertCsvToJsonl(CSV_DATASET_PATH, JSONL_DATASET_PATH);
      uploadDatasetAndFineTuneModel().then((fineTuneId) => {
        console.log(`Fine tune id: ${fineTuneId}`);
      });
    }
  )
  .command(
    "parse <sourceCodeFilePath>",
    "Parses a JavaScript or TypeScript file or directory into a CSV that can be added to the dataset.csv file",
    {},
    (argv) => {
      if (fs.lstatSync(argv.sourceCodeFilePath).isDirectory()) {
        debug("Parsing source code in directory: " + argv.sourceCodeFilePath);
        for (const file of fs.readdirSync(argv.sourceCodeFilePath)) { 
          debug("Checking whether to parse file: " + file);
          if (path.extname(file) === ".js" || path.extname(file) === ".ts") {
            debug("Parsing source code file: " + file);
            parseSourcecode(path.join(argv.sourceCodeFilePath, file));
          }
        }
      } else {
        debug("Parsing source code file: " + argv.sourceCodeFilePath);
        parseSourcecode(argv.sourceCodeFilePath);
      }
    }
  )
  .parse();
