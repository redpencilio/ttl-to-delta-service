# ttl-to-delta-service

Service converting TTL files to delta insertion messages according to the [delta-notifier's format](https://github.com/mu-semtech/delta-notifier).

## How to guides
### Add the service to a stack
Add the service to your `docker-compose.yml`:

```ttl
  ttl-to-delta:
    image: redpencil/ttl-to-delta
    volumes:
      - ./data/files:/share
```

The volume mounted in `/share` contains the TTL files that must be converted. The resulting delta files will be written to the same folder.

Next, make the service listen for new conversion tasks. Assuming a delta-notifier is already availablein the stack, add the following rules to the delta-notifier's configuration in `./config/delta/rules`.

```javascript
export default [
  {
    match: {
      predicate: {
        type: 'uri',
        value: 'http://www.w3.org/ns/adms#status'
      },
      object: {
        type: 'uri',
        value: 'http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7'
      }
    },
    callback: {
      method: 'POST',
      url: 'http://ttl-to-delta/delta'
    },
    options: {
      resourceFormat: 'v0.0.1',
      gracePeriod: 1000,
      ignoreFromSelf: true
    }
  }
];
```

### How to convert a file to delta

In this guide we are going to convert the file `example.ttl` to the delta format.

The first step is to check the path of the file relative to the share directory of the container, for this you have to check the path of your file and what directory is mounted to `/share/` in the `docker-compose.yml` file. In this particular case our path was `/share/example.ttl`.

Once we have the file it's a matter to construct a task Object on the sparql database with the correct information

```
PREFIX adms: <http://www.w3.org/ns/adms#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX task: <http://redpencil.data.gift/vocabularies/tasks/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
INSERT DATA{
  GRAPH <http://mu.semte.ch/graphs/public> {
    <http://mu.semte.ch/test/1234> a <http://mu.semte.ch/vocabularies/ext/TtlToDeltaTask>;
      rdfs:label 'TestTask';
      rdfs:comment 'Test task to try the service';
      task:numberOfRetries 0;
      adms:status <http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7>;
      prov:used <http://mu.semte.ch/test/fileTest>.
      <share://example.ttl> nie:dataSource <http://mu.semte.ch/test/fileTest>.
  }
}
```

From the code above, the only change you must do is change `<share://example.ttl>` to the correct path. The uri of the task must be unique, remember to change it using a uuid generator
The label and comment properties are just for you to differentiate the different tasks, the numberOfRetries one must be initalized to 0. The status uri correspond with the not initialized status and you must set the task to this status when you create it.

When the service finishes the conversion it will change the status of the task to Completed, and will attach the converted files to the original task using the `prov:generated` property.

### How to convert several files at once

Converting several files at the same time is a matter of attaching them to the same task as we can see in the following piece of code:

```
PREFIX adms: <http://www.w3.org/ns/adms#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX task: <http://redpencil.data.gift/vocabularies/tasks/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
INSERT DATA{
  GRAPH <http://mu.semte.ch/graphs/public> {
    <http://mu.semte.ch/test/1234> a <http://mu.semte.ch/vocabularies/ext/TtlToDeltaTask>;
      rdfs:label 'TestTask';
      rdfs:comment 'Test task to try the service';
      task:numberOfRetries 0;
      adms:status ${sparqlEscapeUri(statusUris['not-started'])};
      prov:used <http://mu.semte.ch/test/fileTest1>;
      prov:used <http://mu.semte.ch/test/fileTest2>.
      <share://example.ttl> nie:dataSource <http://mu.semte.ch/test/fileTest1>.
      <share://example2.ttl> nie:dataSource <http://mu.semte.ch/test/fileTest2>.
  }
}
```


## Reference
### Configuration
The following environment variables can be optionally configured:
* `TASK_GRAPH (default: http://mu.semte.ch/graphs/public)`: graph to which to read/write all data about the tasks
* `FILE_GRAPH (default: http://mu.semte.ch/graphs/public)`: graph to which to read/write all data about the source/generated files

### API
#### POST /delta
Endpoint that receives delta's from the [delta-notifier](https://github.com/mu-semtech/delta-notifier) and converts TTL to delta files if the delta message contains an unstarted conversion task.

### File format
The generated delta files follow the [delta-notifier v0.0.1](https://github.com/mu-semtech/delta-notifier#v001) format. The files are written to the same folder as the input file.

### Model
#### Used prefixes
| Prefix | URI                                                       |
|--------|-----------------------------------------------------------|
| adms   | http://www.w3.org/ns/adms#                                |
| rdfs   | http://www.w3.org/2000/01/rdf-schema#                     |
| task   | http://redpencil.data.gift/vocabularies/tasks/            |
| prov   | http://www.w3.org/ns/prov#                                |
| nie    | http://www.semanticdesktop.org/ontologies/2007/01/19/nie# |
| ext    | http://mu.semte.ch/vocabularies/ext/                      |
| task   | http://redpencil.data.gift/vocabularies/task/             |


#### TTL-to-delta tasks
Task to convert TTL files to delta files. Both, the source files and resulting files, are linked to the task.

##### Class
`ext:TtlToDeltaTask` < `task:Task`

##### Properties
| Name   | Predicate        | Range                | Definition                                                                                                                  |
|--------|------------------|----------------------|-----------------------------------------------------------------------------------------------------------------------------|
| status | `adms:status`    | `adms:Status`        | Status of the task, initially set to `<http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7>` |
| source | `prov:used`      | `nfo:FileDataObject` | The TTL file(s) to be converted (see [file data model](https://github.com/mu-semtech/file-service))                         |
| result | `prov:generated` | `nfo:FileDataObject` | Resulting delta files generated by the task (see [file data model](https://github.com/mu-semtech/file-service))             |
___

#### TTL files
The TTL files used as input must be available in the  store according to the [model of the file service](https://github.com/mu-semtech/file-service#resources).

#### Delta files
The generated delta files are written to the store according to the [model of the file service](https://github.com/mu-semtech/file-service#resources). The virtual file is enriched with the following properties:

| Name      | Predicate     | Range           | Definition                                                                                            |
|-----------|---------------|-----------------|-------------------------------------------------------------------------------------------------------|
| publisher | `dct:creator` | `rdfs:Resource` | Creator of the file, in this case always `<http://redpencil.data.gift/services/ttl-to-delta-service>` |


#### TTL-to-delta task statuses
| Label       | URI                                                                                |
|-------------|------------------------------------------------------------------------------------|
| Not started | http://redpencil.data.gift/ttl-to-delta-tasks/8C7E9155-B467-49A4-B047-7764FE5401F7 |
| Ongoing     | http://redpencil.data.gift/ttl-to-delta-tasks/B9418001-7DFE-40EF-8950-235349C2C7D1 |
| Successful  | http://redpencil.data.gift/ttl-to-delta-tasks/89E2E19A-91D0-4932-9720-4D34E62B89A1 |
| Failure     | http://redpencil.data.gift/ttl-to-delta-tasks/B740E2A0-F8CC-443E-A6BE-248393A0A9AE |


