import { app, errorHandler } from 'mu';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import flatten from 'lodash.flatten';
import { Parser } from 'n3';
import { sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime, uuid, query } from 'mu';

const statusUris = {
  'not-started': 'http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7',
  'started': 'http://redpencil.data.gift/ttl-to-delta-tasks/B9418001-7DFE-40EF-8950-235349C2C7D1',
  'completed': 'http://redpencil.data.gift/ttl-to-delta-tasks/89E2E19A-91D0-4932-9720-4D34E62B89A1',
  'error': 'http://redpencil.data.gift/ttl-to-delta-tasks/B740E2A0-F8CC-443E-A6BE-248393A0A9AE',
};

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// parse application/json
app.use(bodyParser.json());

app.get('/import-ttl', async (req,res) => {
  await convertTtlToDelta('example.ttl');
  res.end('ok');
});

app.get('/add-task', async (req,res) =>{
  await query(`
    PREFIX adms: <http://www.w3.org/ns/adms#>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX task: <http://redpencil.data.gift/vocabularies/tasks/>
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
    INSERT DATA{
      GRAPH <http://mu.semte.ch/graphs/public> {
        <http://lblod.data.gift/test/1234> a <http://mu.semte.ch/vocabularies/ext/TtlToDeltaTask>;
          rdfs:label 'TestTask';
          rdfs:comment 'Test task to try the service';
          task:numberOfRetries 0;
          adms:status ${sparqlEscapeUri(statusUris['not-started'])};
          prov:used <http://lblod.data.gift/test/fileTest1234>.
          <share://example.ttl> nie:dataSource <http://lblod.data.gift/test/fileTest1234>.
      }
    }
  `);
  res.end('ok');
});

app.post('/new-ttl', async (req, res) => {
  const delta = req.body;
  const inserts = flatten(delta.map(changeSet => changeSet.inserts));
  const statusTriple = inserts.find((insert) => insert.predicate.value === 'http://www.w3.org/ns/adms#status');
  const taskStatus = statusTriple.object.value;
  const taskUri = statusTriple.subject.value;
  console.log(taskStatus);
  if(taskStatus === 'http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7') {
    const queryResult = await query(`
      PREFIX prov: <http://www.w3.org/ns/prov#>
      PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
      SELECT ?physicalFileUri WHERE {
        ${sparqlEscapeUri(taskUri)} prov:used ?logicalFileUri.
        ?physicalFileUri nie:dataSource ?logicalFileUri.
      }
    `);
    const fileUri = queryResult.results.bindings[0].physicalFileUri.value;
    const filePath = `share/${fileUri.substring(8)}`;
    console.log(filePath);
    await changeTaskStatus(taskUri, 'started');
    const resultFilePath = await convertTtlToDelta(filePath);
    console.log(resultFilePath);
    await addResultFileToTask(taskUri, resultFilePath);
    await changeTaskStatus(taskUri, 'completed');
  } else {
    res.end('Not relevant ttl');
  }

});

async function changeTaskStatus(taskUri, status) {
  const statusUri = statusUris[status];
  await query(`
    PREFIX adms: <http://www.w3.org/ns/adms#>
    DELETE WHERE 
    {
      GRAPH <http://mu.semte.ch/graphs/public> {
          <http://lblod.data.gift/test/1234> adms:status ?status
      }
    }
  `);
  await query(`
    PREFIX adms: <http://www.w3.org/ns/adms#>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/graphs/public> {
        ${sparqlEscapeUri(taskUri)} adms:status ${sparqlEscapeUri(statusUri)}
      }
    }
  `);
}

async function convertTtlToDelta(filePath) {
  const ttl = fs.readFileSync(path.join(__dirname, filePath), {encoding: 'utf-8'});
  const quads = await parseTtl(ttl);
  const inserts = convertQuadsToDelta(quads);
  const deltaMessage = {
    delta: {
      inserts,
      deletes: []
    }
  };
  const resultFilePath = `${filePath.split('.')[0]}.delta`;
  fs.writeFileSync(path.join(__dirname, resultFilePath), JSON.stringify(deltaMessage), {encoding: 'utf-8'});
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
  const fileStats = fs.statSync(path.join(__dirname, filePath));
  const location = filePath.split('/')[1];
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
  await query(`
    PREFIX prov: <http://www.w3.org/ns/prov#>
    INSERT DATA {
      GRAPH <http://mu.semte.ch/graphs/public> {
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
  const queryString = `
    PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
    PREFIX dct: <http://purl.org/dc/terms/>
    PREFIX dbpedia: <http://dbpedia.org/ontology/>
    PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>

    INSERT DATA {
      GRAPH <http://mu.semte.ch/graphs/public> {
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
  `;
  await query(queryString);
  return logicalFileURI;
}

app.get('/test', async (req, res) => {
  console.log('hello');
  res.send('Hello World');
});

app.use(errorHandler);
