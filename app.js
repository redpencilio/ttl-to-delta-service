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
  const statusTriples = inserts.filter((t) => {
    return t.predicate.value == 'http://www.w3.org/ns/adms#status'
      && t.object.value == NOT_STARTED_STATUS;
  });

  if (statusTriples.length) {
    console.log(`Found ${statusTriples.length} TTL to delta tasks.`);
    for (let statusTriple of statusTriples) {
      const taskUri = statusTriple.subject.value;
      // TODO ensure task still exists in NOT_STARTED state
      console.log(`Starting task <${taskUri}>`);
      await changeTaskStatus(taskUri, ONGOING_STATUS);
      const queryResult = await query(`
      PREFIX prov: <http://www.w3.org/ns/prov#>
      PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
      PREFIX dct: <http://purl.org/dc/terms/>
      SELECT ?physicalFileUri
      WHERE {
        GRAPH <${TASK_GRAPH}> {
          ${sparqlEscapeUri(taskUri)} prov:used ?logicalFileUri .
          ?physicalFileUri nie:dataSource ?logicalFileUri ;
            dct:created ?created .
        }
      } ORDER BY ?created`);
      const fileUris = queryResult.results.bindings;
      try {
        for (let i = 0; i < fileUris.length; i++) {
          const fileUri = fileUris[i].physicalFileUri.value;
          const ttlFile = fileUri.replace('share://', '/share/');
          const deltaFile = getPathForDeltaFile(ttlFile);
          await convertTtlToDelta(ttlFile, deltaFile);
          await addResultFileToTask(taskUri, deltaFile);
        }
        await changeTaskStatus(taskUri, SUCCESSFUL_STATUS);
        res.end('Task completed succesfully');
      } catch(e) {
        console.log(e);
        await changeTaskStatus(taskUri, FAILURE_STATUS);
        res.end('Task failed');
      }
    }
  } else {
    console.log('No TTL to delta task found in delta message.');
    res.end('No TTL to delta task found in delta message.');
  }
});

function getPathForDeltaFile(ttlFile) {
  const parsedFilePath = path.parse(ttlFile);
  // unset base such that path.name and path.ext take precedence
  // See https://nodejs.org/api/path.html#path_path_format_pathobject
  parsedFilePath.base = undefined;
  parsedFilePath.ext = '.delta';
  return path.format(parsedFilePath);
}

async function convertTtlToDelta(ttlFile, deltaFile) {
  console.log(`Converting TTL content of ${ttlFile} to delta format. Result will be written to ${deltaFile}`);
  const ttl = fs.readFileSync(ttlFile, { encoding: 'utf-8' });
  const triples = await parseTtl(ttl);
  const inserts = convertTriplesToDelta(triples);
  const deltaMessage = [
    {
      inserts,
      deletes: []
    }
  ];
  fs.writeFileSync(deltaFile, JSON.stringify(deltaMessage), { encoding: 'utf-8' });
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
  const logicalFileUri = `http://redpencil.data.gift/files/${logicalFileUuid}`;
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
          dct:creator <http://redpencil.data.gift/services/ttl-to-delta-service>;
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

app.use(errorHandler);
