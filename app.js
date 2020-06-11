import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import fs from 'fs';
import flatten from 'lodash.flatten';
import { Parser } from 'n3';
import { querySudo as query, updateSudo as update } from '@lblod/mu-auth-sudo';
import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime, uuid } from 'mu';

const TASK_GRAPH = process.env.TASK_GRAPH || 'http://mu.semte.ch/graphs/public';
const FILE_GRAPH = process.env.FILE_GRAPH || 'http://mu.semte.ch/graphs/public';

const NOT_STARTED_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7';
const STARTED_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/B9418001-7DFE-40EF-8950-235349C2C7D1';
const COMPLETED_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/89E2E19A-91D0-4932-9720-4D34E62B89A1';
const ERROR_STATUS = 'http://redpencil.data.gift/ttl-to-delta-tasks/B740E2A0-F8CC-443E-A6BE-248393A0A9AE';

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
      await changeTaskStatus(taskUri, COMPLETED_STATUS);
      res.end('Task completed succesfully');
    } catch(e) {
      console.log(e);
      await changeTaskStatus(taskUri, ERROR_STATUS);
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
  const ttl = fs.readFileSync(filePath, {encoding: 'utf-8'});
  const quads = await parseTtl(ttl);
  const inserts = convertQuadsToDelta(quads);
  const deltaMessage = {
    delta: {
      inserts,
      deletes: []
    }
  };
  const resultFilePath = `${filePath.split('.')[0]}.delta`;
  fs.writeFileSync(resultFilePath, JSON.stringify(deltaMessage), {encoding: 'utf-8'});
  return resultFilePath;
}

function parseTtl(file) {
  return (new Promise((resolve, reject) => {
    const parser = new Parser();
    const quads = [];
    parser.parse(file, (error, quad) => {
      if(error) {
        return reject(error);
      }
      if (quad) {
        quads.push(quad);
      } else {
        resolve(quads);
      }
    });
  }));
}

function convertQuadsToDelta(quads) {
  return quads.map((quad) => {
    return {
      subject: convertToDeltaFormat(quad.subject),
      predicate: convertToDeltaFormat(quad.predicate),
      object: convertToDeltaFormat(quad.object),
    };
  });
}

function convertToDeltaFormat(quadPart) {
  if(quadPart.termType == 'NamedNode') {
    return {
      type: 'uri',
      value: quadPart.value
    };
  } else if(quadPart.termType == 'Literal') {
    return {
      type: 'literal',
      value: quadPart.value,
      datatype: quadPart.datatype.value
    };
  }
}

async function addResultFileToTask(taskUri, filePath) {
  const fileStats = fs.statSync(filePath);
  const location = filePath.split('/').pop();
  const [fileName, fileExtension] = location.split('.');
  const fileInfo = {
    name: fileName,
    extension: fileExtension,
    format: 'application/json',
    created: new Date(fileStats.birthtime),
    size: fileStats.size,
    location: location
  };
  const file = await createFileOnDisk(fileInfo);
  await update(`
    PREFIX prov: <http://www.w3.org/ns/prov#>
    INSERT DATA {
      GRAPH <${TASK_GRAPH}> {
        ${sparqlEscapeUri(taskUri)} prov:generated ${sparqlEscapeUri(file)}
      }
    }
  `);
}

async function createFileOnDisk({name, format, size, extension, created, location}) {
  const logicalFileUuid = uuid();
  const logicalFileURI = `http://data.lblod.info/files/${logicalFileUuid}`;
  const physicalFileUuid = uuid();
  const physicalFileURI = `share://${location}`;
  await update(`
    PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX dbpedia: <http://dbpedia.org/ontology/>
    PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    INSERT DATA {
      GRAPH <${FILE_GRAPH}> {
        ${sparqlEscapeUri(logicalFileURI)} a nfo:FileDataObject;
          mu:uuid ${sparqlEscapeString(logicalFileUuid)};
          nfo:fileName ${sparqlEscapeString(name)};
          dct:format ${sparqlEscapeString(format)};
          nfo:fileSize ${sparqlEscapeInt(size)};
          dbpedia:fileExtension ${sparqlEscapeString(extension)};
          dct:created ${sparqlEscapeDateTime(created)} .
        ${sparqlEscapeUri(physicalFileURI)} a nfo:FileDataObject;
          mu:uuid ${sparqlEscapeString(physicalFileUuid)};
          nfo:fileName ${sparqlEscapeString(name)};
          dct:format ${sparqlEscapeString(format)};
          nfo:fileSize ${sparqlEscapeInt(size)};
          dbpedia:fileExtension ${sparqlEscapeString(extension)};
          dct:created ${sparqlEscapeDateTime(created)};
          nie:dataSource ${sparqlEscapeUri(logicalFileURI)}.
      }
    }
  `);
  return logicalFileURI;
}

app.get('/test', async (req, res) => {
  res.send('Hello World');
});

app.use(errorHandler);
