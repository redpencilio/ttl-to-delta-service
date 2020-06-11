import { app, errorHandler, sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime, uuid } from 'mu';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import flatten from 'lodash.flatten';
import { Parser } from 'n3';
import { querySudo as query, updateSudo as update } from '@lblod/mu-auth-sudo';

const TASK_GRAPH = process.env.TASK_GRAPH || 'http://mu.semte.ch/graphs/public';
const FILE_GRAPH = process.env.FILE_GRAPH || 'http://mu.semte.ch/graphs/public';

const NOT_STARTED_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7';
const ONGOING_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/B9418001-7DFE-40EF-8950-235349C2C7D1';
const SUCCESSFUL_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/89E2E19A-91D0-4932-9720-4D34E62B89A1';
const FAILURE_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/B740E2A0-F8CC-443E-A6BE-248393A0A9AE';

// parse application/json
app.use(bodyParser.json());

app.post('/delta', async (req, res) => {
  const delta = req.body;
  const inserts = flatten(delta.map(changeSet => changeSet.inserts));
  const statusTriple = inserts.find((t) => {
    return t.predicate.value == 'http://www.w3.org/ns/adms#status'
      && t.object.value == NOT_STARTED_STATUS;
  });

  if (statusTriple) {
    const taskUri = statusTriple.subject.value;
    await changeTaskStatus(taskUri, NOT_STARTED_STATUS);
    const queryResult = await query(`
      PREFIX prov: <http://www.w3.org/ns/prov#>
      PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
      SELECT ?physicalFileUri
      WHERE {
        GRAPH <${TASK_GRAPH}> {
          ${sparqlEscapeUri(taskUri)} prov:used ?logicalFileUri.
          ?physicalFileUri nie:dataSource ?logicalFileUri.
        }
      }
    `);
    const fileUris = queryResult.results.bindings;
    try {
      for (let i = 0; i < fileUris.length; i++) {
        const fileUri = fileUris[i].physicalFileUri.value;
        const filePath = fileUri.replace('share://', '/share/');
        const deltaFilePath = await convertTtlToDelta(filePath);
        await addResultFileToTask(taskUri, deltaFilePath);
      }
      await changeTaskStatus(taskUri, SUCCESSFUL_STATUS);
      res.end('Task completed succesfully');
    } catch(e) {
      console.log(e);
      await changeTaskStatus(taskUri, FAILURE_STATUS);
      res.end('Task failed');
    }
  } else {
    res.end('No TTL to delta task found in delta message.');
  }
});

async function changeTaskStatus(taskUri, status) {
  await update(`
    PREFIX adms: <http://www.w3.org/ns/adms#>
    DELETE WHERE
    {
      GRAPH <${TASK_GRAPH}> {
        ${sparqlEscapeUri(taskUri)} adms:status ?status
      }
    }
  `);
  await update(`
    PREFIX adms: <http://www.w3.org/ns/adms#>
    INSERT DATA {
      GRAPH <${TASK_GRAPH}> {
        ${sparqlEscapeUri(taskUri)} adms:status ${sparqlEscapeUri(status)}
      }
    }
  `);
}

async function convertTtlToDelta(filePath) {
  const ttl = fs.readFileSync(filePath, { encoding: 'utf-8' });
  const triples = await parseTtl(ttl);
  const inserts = convertTriplesToDelta(triples);
  const deltaMessage = {
    delta: {
      inserts,
      deletes: []
    }
  };
  const parsedFilePath = path.parse(filePath);
  parsedFilePath.ext = 'delta';
  const deltaFilePath = path.format(parsedFilePath);
  fs.writeFileSync(deltaFilePath, JSON.stringify(deltaMessage), { encoding: 'utf-8' });
  return deltaFilePath;
}

function parseTtl(file) {
  return (new Promise((resolve, reject) => {
    const parser = new Parser();
    const triples = [];
    parser.parse(file, (error, triple) => {
      if (error) {
        reject(error);
      } else if (triple) {
        triples.push(triple);
      } else {
        resolve(triples);
      }
    });
  }));
}

function convertTriplesToDelta(triples) {
  return triples.map((triple) => {
    return {
      subject: convertToDeltaFormat(triple.subject),
      predicate: convertToDeltaFormat(triple.predicate),
      object: convertToDeltaFormat(triple.object),
    };
  });
}

function convertToDeltaFormat(node) {
  if (node.termType == 'NamedNode') {
    return {
      type: 'uri',
      value: node.value
    };
  } else if (node.termType == 'Literal') {
    return {
      type: 'literal',
      value: node.value,
      datatype: node.datatype.value
    };
  } else {
    console.log(`Unknown term-type '${node.termType}'`);
    throw new Error(`Unknown term-type '${node.termType}'`);
  }
}

async function addResultFileToTask(taskUri, filePath) {
  const fileName = path.basename(filePath);
  const extension = path.extname(filePath);
  const format = 'application/json';
  const fileStats = fs.statSync(filePath);
  const created = new Date(fileStats.birthtime);
  const size = fileStats.size;

  const logicalFileUuid = uuid();
  const logicalFileUri = `http://data.lblod.info/files/${logicalFileUuid}`;
  const physicalFileUuid = uuid();
  const physicalFileUri = filePath.replace('/share/', 'share://');

  await update(`
    PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX dbpedia: <http://dbpedia.org/ontology/>
    PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX prov: <http://www.w3.org/ns/prov#>

    INSERT DATA {
      GRAPH <${FILE_GRAPH}> {
        ${sparqlEscapeUri(logicalFileUri)} a nfo:FileDataObject;
          mu:uuid ${sparqlEscapeString(logicalFileUuid)};
          nfo:fileName ${sparqlEscapeString(fileName)};
          dct:format ${sparqlEscapeString(format)};
          nfo:fileSize ${sparqlEscapeInt(size)};
          dbpedia:fileExtension ${sparqlEscapeString(extension)};
          dct:created ${sparqlEscapeDateTime(created)} .
        ${sparqlEscapeUri(physicalFileUri)} a nfo:FileDataObject;
          mu:uuid ${sparqlEscapeString(physicalFileUuid)};
          nfo:fileName ${sparqlEscapeString(fileName)};
          dct:format ${sparqlEscapeString(format)};
          nfo:fileSize ${sparqlEscapeInt(size)};
          dbpedia:fileExtension ${sparqlEscapeString(extension)};
          dct:created ${sparqlEscapeDateTime(created)};
          nie:dataSource ${sparqlEscapeUri(logicalFileUri)}.
      }

      GRAPH <${TASK_GRAPH}> {
        ${sparqlEscapeUri(taskUri)} prov:generated ${sparqlEscapeUri(logicalFileUri)}
      }
    }
  `);
}

app.get('/test', async (req, res) => {
  res.send('Hello World');
});

app.use(errorHandler);
